// SPDX-License-Identifier: Apache-2.0
import { Menu as BaseMenu } from "@base-ui-components/react/menu";
import type { ReactNode } from "react";
import { cn } from "../cn";

/** A kebab (⋮) dropdown. Base UI handles keyboard nav, Escape, focus, click-outside.
 *  Non-modal (like a macOS menu): selecting an item always closes it, and it
 *  doesn't lock the page behind a scrim — so an item that opens a dialog can't
 *  race the menu's body/pointer lock. */
export function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BaseMenu.Root modal={false}>
      <BaseMenu.Trigger className="icon-btn" aria-label={label}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner align="end" sideOffset={4} className="z-30">
          <BaseMenu.Popup className="min-w-[12rem] overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
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
    <BaseMenu.Item
      className={cn("menu-item", danger && "menu-item-danger")}
      // Clicking closes the menu (Base UI default, macOS-style). Any dialog the
      // handler opens then appears over the closed menu, not under it.
      onClick={() => onSelect()}
    >
      {children}
    </BaseMenu.Item>
  );
}
