"use client";

import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FILTER_TRIGGER_CLASS } from "./filter-trigger";

export type FilterOption = { value: string; label: string };

/*
 * Sem "outline-none" nas opções: no Tailwind 4 ele também apagaria o contorno de foco do teclado.
 * O destaque do mouse e das setas é o fundo; o contorno claro aparece só no teclado (:focus-visible).
 */
const optionClass =
  "flex min-h-10 shrink-0 cursor-pointer items-center justify-between gap-4 rounded-md px-3 py-2 text-body text-text-secondary select-none " +
  "data-[highlighted]:bg-surface-hover data-[highlighted]:text-text " +
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text " +
  "data-[state=checked]:bg-primary-tint data-[state=checked]:font-semibold data-[state=checked]:text-primary";

/**
 * Pelo teclado, o foco começa na opção em uso, como numa lista de escolha. O Radix foca a primeira opção
 * ao abrir; um quadro depois, com o menu montado, o foco passa para a escolhida.
 */
function FocusSelected({ target, byKeyboard }: { target: RefObject<HTMLDivElement | null>; byKeyboard: RefObject<boolean> }) {
  useEffect(() => {
    if (!byKeyboard.current) return;
    const frame = requestAnimationFrame(() => target.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [target, byKeyboard]);
  return null;
}

/**
 * Um filtro de escolha única dentro do formulário GET da Visão geral: botão com o valor atual e menu do
 * design system. O valor viaja num campo oculto com o mesmo `name` de antes, e escolher envia o
 * formulário, como as listas nativas faziam.
 *
 * Sem JavaScript o menu não abre: aparece uma lista nativa, que vem ANTES do campo oculto para que a
 * escolha dela seja a lida quando o botão "Aplicar" envia os dois.
 */
export function FilterMenu({
  name,
  label,
  value,
  options,
}: {
  name: string;
  /** Texto fixo do botão, sem os dois-pontos. */
  label: string;
  /** O valor aplicado, vindo da URL. */
  value: string;
  options: FilterOption[];
}) {
  // A escolha aparece no botão na hora; quando a URL muda (aplicar, limpar, voltar), vale o que veio dela.
  // Ajuste durante a renderização, sem trocar a `key`: remontar tiraria o foco do botão depois de aplicar.
  const [state, setState] = useState({ applied: value, chosen: value });
  if (state.applied !== value) setState({ applied: value, chosen: value });
  const chosen = state.applied === value ? state.chosen : value;
  const chosenLabel = options.find((option) => option.value === chosen)?.label ?? chosen;

  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLDivElement>(null);
  const openedByKeyboard = useRef(false);
  const pointer = useRef<string | null>(null);

  function choose(next: string) {
    if (next === chosen || !field.current) return;
    // O campo precisa estar com o valor novo ANTES do envio, que acontece neste mesmo clique.
    field.current.value = next;
    setState({ applied: value, chosen: next });
    field.current.form?.requestSubmit();
  }

  /**
   * O menu do Radix abre assim que o dedo encosta. No toque (e na caneta) isso abriria o menu ao começar
   * uma rolagem em cima do botão, então só o toque completo (o clique) abre.
   */
  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    openedByKeyboard.current = false;
    pointer.current = event.pointerType;
    if (event.pointerType !== "mouse") event.preventDefault();
  }

  function onClick() {
    // Mouse já foi tratado no pointerdown. Sem pointerdown (tecnologia assistiva), o clique também abre.
    if (pointer.current !== "mouse") setOpen((current) => !current);
    pointer.current = null;
  }

  return (
    <div className="max-w-full">
      <noscript>
        <style>{`[data-filter-menu="${name}"]{display:none}`}</style>
        <label className={FILTER_TRIGGER_CLASS}>
          <span className="text-text-secondary">{label}:</span>
          <select name={name} defaultValue={value} aria-label={label} className="min-w-0 border-0 bg-surface font-semibold text-text">
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </noscript>
      <input ref={field} type="hidden" name={name} value={chosen} readOnly />

      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            data-filter-menu={name}
            className={FILTER_TRIGGER_CLASS}
            onPointerDown={onPointerDown}
            onClick={onClick}
            onKeyDown={() => {
              openedByKeyboard.current = true;
              pointer.current = null;
            }}
          >
            <span className="shrink-0 text-text-secondary">{label}:</span>{" "}
            <span className="min-w-0 truncate font-semibold">{chosenLabel}</span>
            <ChevronDown size={14} aria-hidden className="shrink-0 text-text-muted" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={8}
          collisionPadding={16}
          // O próprio botão abre e fecha. Sem isto, o segundo toque nele contaria como "fora" (fecha) e
          // como clique no botão (reabre), e o menu não fecharia.
          onInteractOutside={(event) => {
            if (trigger.current?.contains(event.target as Node)) event.preventDefault();
          }}
          className="max-h-(--radix-dropdown-menu-content-available-height) w-max max-w-[calc(100vw-32px)] min-w-[max(220px,var(--radix-dropdown-menu-trigger-width))] overflow-y-auto rounded-[16px] p-2 outline-none"
        >
          <FocusSelected target={selected} byKeyboard={openedByKeyboard} />
          <DropdownMenuRadioGroup value={chosen} onValueChange={choose} className="flex flex-col gap-1">
            {options.map((option) => (
              <DropdownMenuPrimitive.RadioItem
                key={option.value}
                ref={option.value === chosen ? selected : undefined}
                value={option.value}
                className={optionClass}
              >
                <span className="min-w-0 break-words">{option.label}</span>
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                  <DropdownMenuPrimitive.ItemIndicator>
                    <Check size={16} />
                  </DropdownMenuPrimitive.ItemIndicator>
                </span>
              </DropdownMenuPrimitive.RadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
