// SPDX-License-Identifier: Apache-2.0
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "../cn";

/** A kebab (⋮) dropdown. Radix handles keyboard nav, Escape, focus, click-outside. */
export function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="icon-btn" aria-label={label}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-30 min-w-[12rem] overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  onSelect,
  danger,
  children,
}: {
  onSelect: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item
      className={cn("menu-item", danger && "menu-item-danger")}
      // preventDefault keeps the menu from racing a dialog open / async action.
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
    >
      {children}
    </DropdownMenu.Item>
  );
}
