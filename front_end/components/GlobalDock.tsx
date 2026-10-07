"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { MouseEvent, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { UserAvatar } from "@/front_end/components/account/UserAvatar";
import { LanguageToggle } from "@/front_end/components/LanguageToggle";
import { Dock } from "@/front_end/components/ui/Dock";
import { useAuth } from "@/front_end/state/auth-context";
import { useModalController } from "@/front_end/state/modal-context";
import { cn } from "@/shared/utils";

// typography.nav-link — DESIGN.md's token for exactly this: global nav menu items.
const navLink = "font-text text-nav-link text-ink transition-transform duration-150 ease-out active:scale-95";

export function GlobalDock() {
  const pathname = usePathname();
  const { isAuthenticated, user } = useAuth();
  const { openModal } = useModalController();
  const [mobileOpen, setMobileOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  // Dashboard routes provide their own persistent sidebar navigation. Keeping
  // the marketing dock there duplicates navigation and consumes vertical
  // space that the dashboard shell can use instead.
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/") || pathname === "/demo") return null;

  // Only intercept navigation to /pricing when we're not already there —
  // per Phase 1, on /pricing itself it should just scroll/highlight instead
  // of reopening the modal.
  function handlePricingClick(event: MouseEvent<HTMLAnchorElement>) {
    if (pathname === "/pricing") return;
    event.preventDefault();
    openModal("pricing");
  }

  return (
    <div className="fixed inset-x-0 top-lg z-40 flex flex-col items-center px-lg">
      <Dock className="w-full max-w-4xl px-lg py-xs">
        <div className="flex items-center justify-between gap-lg">
          <div className="flex items-center gap-xs">
            <Link href="/" className="flex items-center gap-xs font-display text-tagline text-ink" onClick={() => setMobileOpen(false)}>
              <Image src="/brand/echo-logo.png" alt="" width={28} height={28} className="h-7 w-7 shrink-0" priority />
              <span>ECHO 回响</span>
            </Link>
            <LanguageToggle />
          </div>

          <nav className="hidden items-center gap-lg md:flex">
            <Link href="/" className={navLink}>
              Home
            </Link>
            <Link href="/pricing" onClick={handlePricingClick} className={navLink}>
              Pricing
            </Link>
            <Link href="/about" className={navLink}>
              About Us
            </Link>
            <Link href="/faq" className={navLink}>
              FAQ
            </Link>

            {isAuthenticated ? (
              <Link href="/dashboard" className={navLink}>
                Dashboard
              </Link>
            ) : (
              <button onClick={() => openModal("auth", { authTab: "register" })} className={cn(navLink, "text-primary")}>
                Register
              </button>
            )}

            {isAuthenticated && user && (
              <button
                onClick={() => openModal("account-settings")}
                className="flex items-center gap-xs rounded-pill py-xxs pl-xxs pr-sm transition-transform duration-150 ease-out active:scale-95"
                aria-label="Account settings"
              >
                <UserAvatar
                  username={user.username}
                  profileImageUrl={user.profileImageUrl}
                  className="h-8 w-8"
                />
                <span className="font-text text-caption text-ink">{user.username}</span>
              </button>
            )}
          </nav>

          <button
            className="flex h-11 w-11 items-center justify-center rounded-full transition-transform duration-150 ease-out active:scale-95 md:hidden"
            aria-label="Toggle menu"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-panel"
            onClick={() => setMobileOpen((open) => !open)}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              {mobileOpen ? (
                <path d="M3 3L15 15M15 3L3 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              ) : (
                <path d="M2 5H16M2 9H16M2 13H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </Dock>

      {/* Rendered as a sibling below the dock, not inside it — keeping it
          inside the pill-shaped Dock made the dock itself grow taller and
          squeezed the links into its rounded-pill width. This panel gets its
          own full-width rounded-lg surface with normal block layout instead. */}
      <div className="w-full max-w-4xl md:hidden" id="mobile-nav-panel">
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ opacity: 0, y: -8, scaleY: 0.95 }}
              animate={{ opacity: 1, y: 0, scaleY: 1 }}
              exit={{ opacity: 0, y: -8, scaleY: 0.95 }}
              transition={{ duration: reduceMotion ? 0 : 0.28, ease: "easeInOut" }}
              style={{ transformOrigin: "top" }}
              className="mt-xs flex flex-col gap-xs overflow-hidden rounded-lg border border-hairline bg-canvas p-lg shadow-dock"
            >
              <Link href="/" className={navLink} onClick={() => setMobileOpen(false)}>
                Home
              </Link>
              <Link
                href="/pricing"
                onClick={(event) => {
                  handlePricingClick(event);
                  setMobileOpen(false);
                }}
                className={navLink}
              >
                Pricing
              </Link>
              <Link href="/about" className={navLink} onClick={() => setMobileOpen(false)}>
                About Us
              </Link>
              <Link href="/faq" className={navLink} onClick={() => setMobileOpen(false)}>
                FAQ
              </Link>
              {isAuthenticated ? (
                <>
                  <Link href="/dashboard" className={navLink} onClick={() => setMobileOpen(false)}>
                    Dashboard
                  </Link>
                  <button
                    onClick={() => {
                      openModal("account-settings");
                      setMobileOpen(false);
                    }}
                    className={cn(navLink, "text-left")}
                  >
                    {user?.username} — Account settings
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    openModal("auth", { authTab: "register" });
                    setMobileOpen(false);
                  }}
                  className={cn(navLink, "text-left text-primary")}
                >
                  Register
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
