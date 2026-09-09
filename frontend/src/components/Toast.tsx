interface ToastProps {
  toast: { msg: string; tone: "ok" | "err" | "warn" } | null;
}

export function Toast({ toast }: ToastProps) {
  return toast ? <div className={`toast ${toast.tone}`}>{toast.msg}</div> : null;
}
