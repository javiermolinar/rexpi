import { Type, type TLiteral, type TUnion } from "typebox";

type Literals<T extends readonly string[]> = { -readonly [K in keyof T]: TLiteral<T[K]> };

/** String enumerations as `anyOf`/`const`. Never emit draft tuple `items` arrays or
    `additionalItems`: strict providers reject tool schemas that use them. */
export function literalUnion<const T extends readonly string[]>(values: T, description?: string): TUnion<Literals<T>> {
  const variants = [...values].map(value => Type.Literal(value)) as unknown as Literals<T>;
  return Type.Union(variants, description === undefined ? undefined : { description }) as TUnion<Literals<T>>;
}

export const LAUNCH_PLACEMENTS = ["session", "right", "down", "tab"] as const;
export const TERMINAL_PLACEMENTS = ["right", "down", "tab", "floating"] as const;
export const LAUNCH_ROLES = ["chat", "review"] as const;
export const ENDPOINT_ROLES = ["main", "chat", "review"] as const;
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MESSAGE_KINDS = ["progress", "question", "result"] as const;
