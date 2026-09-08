"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission } from "@/server/authz/permissions";
import { encryptCpfCnpj, decryptCpfCnpj } from "@/server/crypto/contact-sensitive";
import { toUserMessage } from "@/lib/errors";
import {
  addEmailSchema,
  addPhoneSchema,
  clearCpfCnpjSchema,
  createContactSchema,
  dismissDuplicateCandidateSchema,
  mergeContactsSchema,
  removeEmailSchema,
  removePhoneSchema,
  revealCpfCnpjSchema,
  setCpfCnpjSchema,
  unmergeContactSchema,
  updateContactBasicFieldsSchema,
  updateEmailSchema,
  updatePhoneSchema,
} from "./schema";

export type ContactActionState = {
  ok: boolean;
  error?: string;
  contactId?: string;
};

/**
 * Cria o contato. CPF/CNPJ, quando informado, é cifrado AQUI (Node) antes
 * de qualquer coisa tocar o banco — a função RPC só recebe ciphertext e
 * blind index já prontos, nunca o valor em claro (docs/decisoes/a3-criptografia.md).
 */
export async function createContactAction(
  _prevState: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const ctx = await requirePermission("contact.edit");

  const rawPhones = formData.getAll("phone").filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const rawEmails = formData.getAll("email").filter((v): v is string => typeof v === "string" && v.trim() !== "");

  const parsed = createContactSchema.safeParse({
    workspaceId: ctx.workspaceId,
    type: formData.get("type"),
    name: formData.get("name"),
    city: formData.get("city") ?? "",
    uf: formData.get("uf") ?? "",
    preferredChannel: formData.get("preferredChannel") || undefined,
    phones: rawPhones,
    emails: rawEmails,
    cpfCnpj: formData.get("cpfCnpj") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();

  let cpfPayload: { ciphertext: string; blindIndex: string; keyVersion: string } | null = null;
  if (parsed.data.cpfCnpj) {
    const encrypted = encryptCpfCnpj(ctx.workspaceId, parsed.data.cpfCnpj);
    cpfPayload = {
      ciphertext: encrypted.ciphertextBase64,
      blindIndex: encrypted.blindIndexBase64,
      keyVersion: encrypted.keyVersion,
    };
  }

  // exactOptionalPropertyTypes: uma propriedade opcional não aceita a
  // CHAVE presente com valor `undefined` — só a chave AUSENTE conta como
  // "não informado". Espalhamento condicional em vez de `campo: x ||
  // undefined`.
  const { data, error } = await supabase.rpc("create_contact", {
    p_workspace_id: ctx.workspaceId,
    p_type: parsed.data.type,
    p_name: parsed.data.name,
    ...(parsed.data.city ? { p_city: parsed.data.city } : {}),
    ...(parsed.data.uf ? { p_uf: parsed.data.uf } : {}),
    ...(parsed.data.preferredChannel ? { p_preferred_channel: parsed.data.preferredChannel } : {}),
    p_phones: parsed.data.phones.map((value) => ({ value_normalized: value, is_primary: false })),
    p_emails: parsed.data.emails.map((value) => ({ value_normalized: value, is_primary: false })),
    ...(cpfPayload
      ? {
          p_cpf_ciphertext_base64: cpfPayload.ciphertext,
          p_cpf_blind_index_base64: cpfPayload.blindIndex,
          p_cpf_key_version: cpfPayload.keyVersion,
        }
      : {}),
  });

  if (error || !data) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/contatos");
  redirect(`/contatos/${data.id}`);
}

export async function updateContactBasicFieldsAction(
  _prevState: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  await requirePermission("contact.edit");

  const parsed = updateContactBasicFieldsSchema.safeParse({
    contactId: formData.get("contactId"),
    name: formData.get("name"),
    city: formData.get("city") ?? "",
    uf: formData.get("uf") ?? "",
    preferredChannel: formData.get("preferredChannel") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_contact_basic_fields", {
    p_contact_id: parsed.data.contactId,
    p_name: parsed.data.name,
    ...(parsed.data.city ? { p_city: parsed.data.city } : {}),
    ...(parsed.data.uf ? { p_uf: parsed.data.uf } : {}),
    ...(parsed.data.preferredChannel ? { p_preferred_channel: parsed.data.preferredChannel } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/contatos/${parsed.data.contactId}`);
  return { ok: true, contactId: parsed.data.contactId };
}

export async function addPhoneAction(formData: FormData): Promise<void> {
  await requirePermission("contact.edit");
  const parsed = addPhoneSchema.safeParse({
    contactId: formData.get("contactId"),
    value: formData.get("value"),
    isPrimary: formData.get("isPrimary") === "on",
  });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("add_contact_phone", {
    p_contact_id: parsed.data.contactId,
    p_value_normalized: parsed.data.value,
    p_is_primary: parsed.data.isPrimary,
  });

  revalidatePath(`/contatos/${parsed.data.contactId}`);
}

export async function updatePhoneAction(formData: FormData): Promise<void> {
  await requirePermission("contact.edit");
  const parsed = updatePhoneSchema.safeParse({
    phoneId: formData.get("phoneId"),
    value: formData.get("value"),
  });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("update_contact_phone", {
    p_phone_id: parsed.data.phoneId,
    p_value_normalized: parsed.data.value,
  });

  const contactId = formData.get("contactId");
  if (typeof contactId === "string") revalidatePath(`/contatos/${contactId}`);
}

export async function removePhoneAction(formData: FormData): Promise<void> {
  await requirePermission("contact.edit");
  const parsed = removePhoneSchema.safeParse({ phoneId: formData.get("phoneId") });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("remove_contact_phone", { p_phone_id: parsed.data.phoneId });

  const contactId = formData.get("contactId");
  if (typeof contactId === "string") revalidatePath(`/contatos/${contactId}`);
}

export async function addEmailAction(formData: FormData): Promise<void> {
  await requirePermission("contact.edit");
  const parsed = addEmailSchema.safeParse({
    contactId: formData.get("contactId"),
    value: formData.get("value"),
    isPrimary: formData.get("isPrimary") === "on",
  });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("add_contact_email", {
    p_contact_id: parsed.data.contactId,
    p_value_normalized: parsed.data.value,
    p_is_primary: parsed.data.isPrimary,
  });

  revalidatePath(`/contatos/${parsed.data.contactId}`);
}

export async function updateEmailAction(formData: FormData): Promise<void> {
  await requirePermission("contact.edit");
  const parsed = updateEmailSchema.safeParse({
    emailId: formData.get("emailId"),
    value: formData.get("value"),
  });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("update_contact_email", {
    p_email_id: parsed.data.emailId,
    p_value_normalized: parsed.data.value,
  });

  const contactId = formData.get("contactId");
  if (typeof contactId === "string") revalidatePath(`/contatos/${contactId}`);
}

export async function removeEmailAction(formData: FormData): Promise<void> {
  await requirePermission("contact.edit");
  const parsed = removeEmailSchema.safeParse({ emailId: formData.get("emailId") });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("remove_contact_email", { p_email_id: parsed.data.emailId });

  const contactId = formData.get("contactId");
  if (typeof contactId === "string") revalidatePath(`/contatos/${contactId}`);
}

export async function setCpfCnpjAction(
  _prevState: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const ctx = await requirePermission("contact.edit");

  const parsed = setCpfCnpjSchema.safeParse({
    contactId: formData.get("contactId"),
    value: formData.get("value"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "CPF/CNPJ inválido." };
  }

  const encrypted = encryptCpfCnpj(ctx.workspaceId, parsed.data.value);

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_contact_cpf_cnpj", {
    p_contact_id: parsed.data.contactId,
    p_ciphertext_base64: encrypted.ciphertextBase64,
    p_blind_index_base64: encrypted.blindIndexBase64,
    p_key_version: encrypted.keyVersion,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/contatos/${parsed.data.contactId}`);
  return { ok: true, contactId: parsed.data.contactId };
}

export async function clearCpfCnpjAction(formData: FormData): Promise<void> {
  await requirePermission("contact.edit");
  const parsed = clearCpfCnpjSchema.safeParse({ contactId: formData.get("contactId") });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("clear_contact_cpf_cnpj", { p_contact_id: parsed.data.contactId });

  revalidatePath(`/contatos/${parsed.data.contactId}`);
}

export type RevealState = {
  ok: boolean;
  error?: string;
  value?: string;
};

/**
 * Revelação: nunca cacheada (Server Action comum, sem fetch GET por trás),
 * decifra só o suficiente para devolver ao chamador desta chamada — o
 * valor não é persistido em nenhum estado do servidor depois de retornar.
 * A auditoria (quem/quando/por quê, nunca o valor) acontece dentro da
 * própria função RPC, antes de qualquer decifra acontecer aqui.
 */
export async function revealContactCpfCnpjAction(formData: FormData): Promise<RevealState> {
  await requirePermission("contact.reveal_sensitive");

  const parsed = revealCpfCnpjSchema.safeParse({
    contactId: formData.get("contactId"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("reveal_contact_cpf_cnpj", {
    p_contact_id: parsed.data.contactId,
    ...(parsed.data.reason ? { p_reason: parsed.data.reason } : {}),
  });

  if (error || !data || data.length === 0) {
    return { ok: false, error: toUserMessage(error) };
  }

  const row = data[0]!;
  const plaintext = decryptCpfCnpj(row.ciphertext_base64, row.key_version);

  return { ok: true, value: plaintext };
}

export async function dismissDuplicateCandidateAction(formData: FormData): Promise<void> {
  await requirePermission("contact.merge");
  const parsed = dismissDuplicateCandidateSchema.safeParse({ candidateId: formData.get("candidateId") });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("dismiss_duplicate_candidate", { p_candidate_id: parsed.data.candidateId });

  revalidatePath("/contatos/duplicidades");
}

export type MergeState = {
  ok: boolean;
  error?: string;
};

export async function mergeContactsAction(
  _prevState: MergeState,
  formData: FormData,
): Promise<MergeState> {
  await requirePermission("contact.merge");

  const fieldResolutions: Record<string, "a" | "b"> = {};
  for (const field of ["name", "city", "uf", "preferred_channel"] as const) {
    const choice = formData.get(`resolution_${field}`);
    if (choice === "a" || choice === "b") fieldResolutions[field] = choice;
  }

  const parsed = mergeContactsSchema.safeParse({
    keptContactId: formData.get("keptContactId"),
    mergedContactId: formData.get("mergedContactId"),
    candidateId: formData.get("candidateId") || undefined,
    fieldResolutions,
  });
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("merge_contacts", {
    p_kept_contact_id: parsed.data.keptContactId,
    p_merged_contact_id: parsed.data.mergedContactId,
    p_field_resolutions: parsed.data.fieldResolutions,
    ...(parsed.data.candidateId ? { p_candidate_id: parsed.data.candidateId } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/contatos");
  revalidatePath("/contatos/duplicidades");
  redirect(`/contatos/${parsed.data.keptContactId}`);
}

export async function unmergeContactAction(formData: FormData): Promise<MergeState> {
  await requirePermission("contact.merge");
  const parsed = unmergeContactSchema.safeParse({ mergeId: formData.get("mergeId") });
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("unmerge_contact", { p_merge_id: parsed.data.mergeId });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/contatos");
  return { ok: true };
}
