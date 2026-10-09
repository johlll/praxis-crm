/**
 * Comparação por campo com a BASE da última sincronização (§6.3).
 *
 * Nunca se decide conflito por `updated`/`updated_at`: cada campo é
 * comparado com o que os dois lados tinham na última vez em que
 * concordaram. Só há conflito quando AMBOS mudaram o mesmo campo para
 * valores diferentes — e, nesse caso, o Google prevalece, mas o valor do CRM
 * sai daqui como conflito para ser GRAVADO (nunca descartado em silêncio).
 *
 * Função pura: nenhuma chamada externa.
 */

export type FieldName = "title" | "schedule" | "cancellation" | "meet";

/** Estado comparável de um compromisso (de um dos dois lados, ou da base). */
export type SyncState = {
  title: string | null;
  /** Instantes ISO. `schedule` é início+fim, sempre juntos. */
  start: string | null;
  end: string | null;
  cancelled: boolean;
  hasMeet: boolean;
};

/** O que o CRM quer agora. Campo ausente = o CRM não está pedindo mudança. */
export type Wanted = {
  title?: string | undefined;
  schedule?: { start: string; end: string } | undefined;
  /** Só existe pedido de ADICIONAR Meet. */
  meet?: true | undefined;
};

export type Conflict = {
  field: FieldName;
  crmValue: unknown;
  googleValue: unknown;
};

export type MergePlan = {
  /** Mudanças só do CRM, a enviar ao Google. */
  push: Wanted;
  /** Em conflito: o valor do Google prevalece e deve ser aplicado ao CRM. */
  conflicts: Conflict[];
  /** Campos cuja base pode avançar para o valor atual do Google. */
  reconciled: FieldName[];
  /** O Google cancelou o evento (nada a enviar). */
  googleCancelled: boolean;
};

const sameInstant = (a: string | null, b: string | null): boolean =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

const sameSchedule = (a: SyncState, b: { start: string | null; end: string | null }): boolean =>
  sameInstant(a.start, b.start) && sameInstant(a.end, b.end);

export function mergeFields(base: SyncState, wanted: Wanted, google: SyncState): MergePlan {
  const push: Wanted = {};
  const conflicts: Conflict[] = [];
  const reconciled: FieldName[] = [];

  // Cancelamento: o Google cancelou o evento.
  const googleCancelled = google.cancelled && !base.cancelled;
  if (googleCancelled) {
    const crmEdited =
      (wanted.title !== undefined && wanted.title !== base.title) ||
      (wanted.schedule !== undefined && !sameSchedule(base, wanted.schedule));
    if (crmEdited) {
      conflicts.push({
        field: "cancellation",
        crmValue: { title: wanted.title ?? null, schedule: wanted.schedule ?? null },
        googleValue: { cancelled: true },
      });
    }
    reconciled.push("cancellation");
    return { push, conflicts, reconciled, googleCancelled };
  }

  // Título.
  if (wanted.title !== undefined) {
    const crmChanged = wanted.title !== base.title;
    const googleChanged = google.title !== base.title;
    if (crmChanged && googleChanged) {
      if (wanted.title === google.title) reconciled.push("title");
      else {
        conflicts.push({ field: "title", crmValue: wanted.title, googleValue: google.title });
        reconciled.push("title");
      }
    } else if (crmChanged) {
      push.title = wanted.title;
      reconciled.push("title");
    }
  }

  // Horário (início e fim, juntos).
  if (wanted.schedule !== undefined) {
    const crmChanged = !sameSchedule(base, wanted.schedule);
    const googleChanged = !sameSchedule(base, google);
    if (crmChanged && googleChanged) {
      if (sameSchedule(google, wanted.schedule)) reconciled.push("schedule");
      else {
        conflicts.push({
          field: "schedule",
          crmValue: wanted.schedule,
          googleValue: { start: google.start, end: google.end },
        });
        reconciled.push("schedule");
      }
    } else if (crmChanged) {
      push.schedule = wanted.schedule;
      reconciled.push("schedule");
    }
  }

  // Meet: só pedido de adicionar.
  if (wanted.meet === true) {
    if (google.hasMeet) {
      // O Google já tem conferência (ou alguém a adicionou lá): adota-se, o
      // pedido do CRM é registrado como atendido sem conflito.
      reconciled.push("meet");
    } else {
      push.meet = true;
      reconciled.push("meet");
    }
  }

  return { push, conflicts, reconciled, googleCancelled: false };
}

/** O evento no Google difere da base em algum campo sincronizado? */
export function googleChangedSinceBase(base: SyncState, google: SyncState): boolean {
  return (
    google.title !== base.title ||
    !sameSchedule(base, google) ||
    google.cancelled !== base.cancelled ||
    google.hasMeet !== base.hasMeet
  );
}
