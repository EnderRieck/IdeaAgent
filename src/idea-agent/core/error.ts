export class KernelError extends Error {
  constructor(message: string, public readonly code: string = "KERNEL_ERROR") {
    super(message);
  }
}

export class ActionDispatchError extends KernelError {
  constructor(message: string) {
    super(message, "ACTION_DISPATCH_ERROR");
  }
}
