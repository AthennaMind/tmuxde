"use client";

import React from "react";
import { AlertTriangle, RefreshCw, Copy, RotateCcw } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { copyText, copyFailureReason } from "@/lib/clipboard";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackMessage?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
  /** Result of the last Copy Error press, shown next to the button. */
  copyResult: string | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
      copyResult: null,
    };
  }

  static getDerivedStateFromError(error: Error) {
    // `copyResult` too: it belongs to the error being shown, and a stale
    // "Copied" over a *different* stack is a lie about which one you have.
    return { hasError: true, error, copyResult: null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // #16: Structured console logging
    console.error("[ErrorBoundary]", {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  /**
   * Copy the stack, without throwing inside the screen that reports throwing.
   *
   * `navigator.clipboard` exists only in a secure context, and `mtmux start`
   * serves the app over plain http on the LAN — so on the product's primary
   * path this was an unhandled rejection raised from the error UI itself, with
   * the button giving no sign either way. `copyText` has the execCommand
   * fallback that actually works there; when even that fails the user is told
   * why, because "nothing happened" is the one outcome they cannot act on.
   */
  private handleCopyError = () => {
    const { error } = this.state;
    if (!error) return;
    const text = `${error.message}\n\n${error.stack ?? ""}`;
    void copyText(text).then(
      (ok) =>
        this.setState({ copyResult: ok ? "Copied" : copyFailureReason() }),
      () => this.setState({ copyResult: copyFailureReason() }),
    );
  };

  private handleRetry = () => {
    if (this.state.retryCount === 0) {
      // First retry: soft reset — just re-render without clearing state
      this.setState((s) => ({
        hasError: false,
        error: null,
        copyResult: null,
        retryCount: s.retryCount + 1,
      }));
    } else {
      // Subsequent retries: hard reset — clear active session + panes
      useSessionStore.getState().setActiveSession(null);
      usePaneStore.getState().clearAll();
      this.setState({
        hasError: false,
        error: null,
        copyResult: null,
        retryCount: 0,
      });
    }
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-4 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <div>
            <p className="text-sm font-medium">
              {this.props.fallbackMessage ?? "Something went wrong"}
            </p>
            <p className="text-xs text-muted-foreground max-w-sm mt-1">
              {this.state.error?.message}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={this.handleCopyError}>
              <Copy className="mr-1.5 h-3 w-3" />
              Copy Error
            </Button>
            <Button variant="outline" size="sm" onClick={this.handleRetry}>
              <RefreshCw className="mr-1.5 h-3 w-3" />
              Retry
            </Button>
            <Button variant="outline" size="sm" onClick={this.handleReload}>
              <RotateCcw className="mr-1.5 h-3 w-3" />
              Reload Page
            </Button>
          </div>
          {this.state.copyResult && (
            <p
              className="max-w-sm text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {this.state.copyResult}
            </p>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
