// SPDX-License-Identifier: Apache-2.0
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" };

export function Button({ variant = "primary", className, ...props }: Props) {
  return (
    <button
      className={cn("btn", variant === "primary" ? "btn-primary" : "btn-ghost", className)}
      {...props}
    />
  );
}
