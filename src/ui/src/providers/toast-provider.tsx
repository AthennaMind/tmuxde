import { Toaster } from "sonner";

export function ToastProvider() {
  return (
    <Toaster
      position="top-center"
      visibleToasts={3}
      duration={4000}
      /*
       * Clear of the account header on a phone.
       *
       * Toasts are top-center and the account chrome is a `sticky top-0` bar
       * 3.5rem tall, so on a 390px screen a toast landed squarely over the
       * sign-out button — the one control you need when a toast is telling you
       * something went wrong with the account you are in. `mobileOffset` only
       * applies below sonner's 600px breakpoint, so the terminal's toasts on a
       * desktop are untouched.
       */
      mobileOffset={{
        top: "calc(3.5rem + env(safe-area-inset-top) + 8px)",
        left: "16px",
        right: "16px",
      }}
      toastOptions={{
        classNames: {
          toast: "bg-background text-foreground border-border",
          description: "text-muted-foreground",
        },
      }}
    />
  );
}
