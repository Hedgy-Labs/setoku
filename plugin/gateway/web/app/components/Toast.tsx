// SPDX-License-Identifier: Apache-2.0
// shadcn-style toast via sonner (https://ui.shadcn.com/docs/components/radix/sonner).
// Mount <Toaster /> once at the app root; call `toast("…")` from anywhere.
import { Toaster as Sonner, type ToasterProps } from "sonner";

export { toast } from "sonner";

export function Toaster(props: ToasterProps) {
  return <Sonner theme="light" position="bottom-right" richColors closeButton {...props} />;
}
