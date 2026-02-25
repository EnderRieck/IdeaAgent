// Dynamic loader for ink (ESM-only package in a CJS project).
// Call initInk() once before rendering. Components use getInk().

interface InkAPI {
  render: typeof import("ink")["render"];
  Box: typeof import("ink")["Box"];
  Text: typeof import("ink")["Text"];
  Static: typeof import("ink")["Static"];
  useInput: typeof import("ink")["useInput"];
  useApp: typeof import("ink")["useApp"];
}

let _ink: InkAPI | undefined;

// Use new Function to preserve native import() — tsc would otherwise compile it to require()
const nativeImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;

export async function initInk(): Promise<InkAPI> {
  if (!_ink) {
    const mod = await nativeImport("ink");
    _ink = {
      render: mod.render,
      Box: mod.Box,
      Text: mod.Text,
      Static: mod.Static,
      useInput: mod.useInput,
      useApp: mod.useApp,
    };
  }
  return _ink;
}

export function getInk(): InkAPI {
  if (!_ink) throw new Error("Call initInk() before using ink components");
  return _ink;
}
