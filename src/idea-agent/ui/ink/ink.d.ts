declare module "ink" {
  import type { FC, ReactNode, Key } from "react";

  interface Instance {
    unmount(): void;
    waitUntilExit(): Promise<void>;
    rerender(tree: ReactNode): void;
  }

  interface RenderOptions {
    stdout?: NodeJS.WriteStream;
    stdin?: NodeJS.ReadStream;
    exitOnCtrlC?: boolean;
  }

  export function render(tree: ReactNode, options?: RenderOptions): Instance;

  interface BoxProps {
    flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
    padding?: number;
    paddingX?: number;
    paddingY?: number;
    margin?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    borderStyle?: "single" | "double" | "round" | "bold" | "singleDouble" | "doubleSingle" | "classic";
    borderColor?: string;
    width?: number | string;
    minWidth?: number;
    height?: number | string;
    minHeight?: number;
  }

  interface TextProps {
    color?: string;
    backgroundColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    dimColor?: boolean;
    inverse?: boolean;
    wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
    children?: ReactNode;
  }

  export const Box: FC<BoxProps & { children?: ReactNode }>;
  export const Text: FC<TextProps>;

  interface KeyInput {
    upArrow: boolean;
    downArrow: boolean;
    leftArrow: boolean;
    rightArrow: boolean;
    return: boolean;
    escape: boolean;
    ctrl: boolean;
    shift: boolean;
    meta: boolean;
    tab: boolean;
    backspace: boolean;
    delete: boolean;
    pageUp: boolean;
    pageDown: boolean;
  }

  interface StaticProps<T> {
    items: T[];
    children: (item: T, index: number) => ReactNode;
  }

  export const Static: <T>(props: StaticProps<T>) => ReactNode;

  export function useInput(handler: (input: string, key: KeyInput) => void): void;
  export function useApp(): { exit(error?: Error): void };
}
