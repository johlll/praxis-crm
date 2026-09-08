import { z } from "zod";

export const signUpSchema = z.object({
  fullName: z.string().trim().min(1, "Informe seu nome.").max(120),
  email: z.string().trim().toLowerCase().email("Informe um e-mail válido."),
  password: z.string().min(8, "A senha precisa ter pelo menos 8 caracteres."),
});

export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email("Informe um e-mail válido."),
  password: z.string().min(1, "Informe sua senha."),
});
