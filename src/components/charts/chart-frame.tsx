"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type Size = { width: number; height: number };

/**
 * Tamanho do elemento, medido no navegador. `null` até medir: no servidor,
 * antes da hidratação e onde não existe ResizeObserver (testes em jsdom),
 * o gráfico simplesmente não é desenhado — os números continuam na tabela
 * ao lado, que não depende disto.
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const next = { width: Math.floor(rect.width), height: Math.floor(rect.height) };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

/**
 * Área do gráfico. Altura FIXA (`height`) ou, com `fill`, a altura que
 * sobrar no cartão, nunca menos que `minHeight` — em ambos os casos o eixo
 * já está dentro, e a página não pula quando o gráfico aparece. O servidor
 * e a primeira renderização do navegador desenham a mesma reserva vazia
 * (sem diferença de hidratação); o gráfico entra depois de medir.
 */
export function ChartFrame({
  height,
  minHeight,
  fill = false,
  placeholder,
  children,
}: {
  height?: number;
  minHeight?: number;
  fill?: boolean;
  /** Reserva própria (ex.: o anel da rosca com o total); sem ela, linhas de grade vazias. */
  placeholder?: ReactNode;
  children: (size: Size) => ReactNode;
}) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const ready = size !== null && size.width > 0 && size.height > 0;
  return (
    <div
      ref={ref}
      className={fill ? "relative w-full min-w-0 flex-1" : "relative w-full min-w-0"}
      style={fill ? { minHeight } : { height }}
    >
      {ready ? (
        <div className="absolute inset-0">{children(size)}</div>
      ) : placeholder ? (
        placeholder
      ) : (
        <div aria-hidden className="absolute inset-0 flex flex-col justify-between py-3">
          <span className="h-px w-full bg-border-subtle" />
          <span className="h-px w-full bg-border-subtle" />
          <span className="h-px w-full bg-border-subtle" />
          <span className="h-px w-full bg-border" />
        </div>
      )}
    </div>
  );
}
