import { useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { TaskCompletionEffects } from "./space-enhancement-state";
import "./space-enhancements.css";

function canAnimate(effect: string) {
  const root = document.documentElement;
  return root.dataset.spaceMotion === "on" && root.dataset.spacePaused !== "true" && root.getAttribute(`data-space-${effect}`) !== "off" && document.visibilityState !== "hidden" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SideNavigationOrbit() {
  const ref = useRef<HTMLSpanElement>(null);
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const marker = ref.current;
    const nav = marker?.parentElement;
    if (!marker || !nav) return;
    const measure = () => {
      const current = nav.querySelector<HTMLElement>('.side-nav-item[aria-current="page"]');
      if (!current) { marker.dataset.ready = "false"; return; }
      marker.style.setProperty("--nav-orbit-y", `${current.offsetTop + current.offsetHeight / 2 - 17}px`);
      marker.dataset.ready = "true";
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [pathname]);
  return <span ref={ref} className="side-nav-orbit" aria-hidden="true"><span /></span>;
}

export function PageEntrance() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const main = document.getElementById("main");
    if (!main) return;
    let waitingForPreference = document.documentElement.dataset.spaceMotion === undefined;
    if (!waitingForPreference && !canAnimate("entrance")) return;
    const decorated = new Set<HTMLElement>();
    let headingDone = false;
    let moduleDone = false;
    const clear = () => decorated.forEach(node => node.classList.remove("space-enter-heading", "space-enter-module"));
    const decorate = () => {
      if (waitingForPreference) return;
      if (!canAnimate("entrance")) { clear(); observer.disconnect(); return; }
      if (!headingDone) {
        const title = main.querySelector<HTMLElement>("h1");
        if (title) {
          const target = title.closest<HTMLElement>(".page-head, .upload-header-bar, .video-page-topbar") ?? title;
          target.classList.add("space-enter-heading"); target.dataset.spaceEntered = "heading";
          decorated.add(target); headingDone = true;
        }
      }
      if (!moduleDone) {
        const target = Array.from(main.querySelectorAll<HTMLElement>(".video-grid, .upload-workspace, .upload-source-grid, .panel, .sci-form-panel, .installation-form, .account-security, .empty"))
          .find(node => !node.querySelector("h1") && !Array.from(decorated).some(heading => heading.contains(node)) && node.getBoundingClientRect().top < window.innerHeight && node.getBoundingClientRect().bottom > 0);
        if (target) { target.classList.add("space-enter-module"); target.dataset.spaceEntered = "module"; decorated.add(target); moduleDone = true; }
      }
      if (headingDone && moduleDone) observer.disconnect();
    };
    const observer = new MutationObserver(decorate);
    observer.observe(main, { childList: true, subtree: true });
    const preferences = new MutationObserver(() => {
      if (waitingForPreference) {
        if (document.documentElement.dataset.spaceMotion === undefined) return;
        waitingForPreference = false; decorate();
      } else if (!canAnimate("entrance")) { clear(); observer.disconnect(); }
    });
    preferences.observe(document.documentElement, { attributes: true, attributeFilter: ["data-space-motion", "data-space-paused", "data-space-entrance"] });
    const finished = (event: AnimationEvent) => {
      if (event.animationName === "space-page-enter" && event.target instanceof HTMLElement) event.target.classList.remove("space-enter-heading", "space-enter-module");
    };
    main.addEventListener("animationend", finished);
    decorate();
    const deadline = window.setTimeout(() => observer.disconnect(), 1800);
    return () => { observer.disconnect(); preferences.disconnect(); window.clearTimeout(deadline); main.removeEventListener("animationend", finished); clear(); };
  }, [pathname]);
  return null;
}

export function TaskCompletionHalo({ effects, taskId }: { effects: TaskCompletionEffects; taskId: string }) {
  const [active, setActive] = useState(false);
  const confirmedAt = effects.confirmedAt(taskId);
  useLayoutEffect(() => {
    if (!effects.consume(taskId)) return;
    if (!canAnimate("completion") || document.querySelector('dialog[open]:not([data-space-settings]), [role="alertdialog"], [aria-modal="true"]:not([data-space-settings])')) return;
    setActive(true);
    const timer = window.setTimeout(() => setActive(false), 1000);
    const preference = new MutationObserver(() => { if (!canAnimate("completion")) setActive(false); });
    preference.observe(document.documentElement, { attributes: true, attributeFilter: ["data-space-motion", "data-space-paused", "data-space-completion"] });
    return () => { window.clearTimeout(timer); preference.disconnect(); };
  }, [effects, taskId, confirmedAt]);
  return active ? <span className="task-completion-halo" aria-hidden="true" onAnimationEnd={() => setActive(false)} /> : null;
}
