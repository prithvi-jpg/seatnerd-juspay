/**
 * Minimal type declarations for @juspay-tech/react-hyper-js v2.x.
 * Exported surface verified from dist/index.mjs (bundle).
 */

declare module "@juspay-tech/react-hyper-js" {
  import type { JSX } from "react";

  export interface HyperAppearance {
    theme?: "light" | "night" | "flat";
    variables?: Record<string, string>;
    rules?: Record<string, unknown>;
    labels?: Record<string, unknown>;
  }

  export interface ElementsOptions {
    clientSecret: string;
    appearance?: HyperAppearance;
    fonts?: Array<unknown>;
    locale?: string;
    loader?: "auto" | "always" | "never";
    ephemeralKey?: string;
  }

  export interface UnifiedCheckoutProps {
    id?: string;
    options?: Partial<ElementsOptions>;
    componentType?: string;
    onReady?: (param: unknown) => void;
    onChange?: (param: unknown) => void;
    onFocus?: (param: unknown) => void;
    onBlur?: (param: unknown) => void;
    onClick?: (param: unknown) => void;
    onPaymentComplete?: (param: unknown) => void;
    onPaymentButtonClick?: (param: unknown) => void;
  }

  export function HyperElements(props: {
    options: ElementsOptions;
    children?: React.ReactNode;
  }): JSX.Element;

  export function UnifiedCheckout(props: UnifiedCheckoutProps): JSX.Element;
  export function PaymentElement(props: UnifiedCheckoutProps): JSX.Element;
  export function CardElement(props: UnifiedCheckoutProps): JSX.Element;

  export interface HyperInstance {
    clientSecret: string;
    confirmPayment: (payload: Record<string, unknown>) => Promise<{ error?: unknown; paymentIntent?: Record<string, unknown> }>;
    confirmCardPayment: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    retrievePaymentIntent: (clientSecret: string) => Promise<Record<string, unknown>>;
  }

  export function useHyper(): HyperInstance;
  export function useWidgets(): Record<string, unknown>;
  /** @deprecated */
  export function useElements(): Record<string, unknown>;
  /** @deprecated */
  export function useStripe(): HyperInstance;
}
