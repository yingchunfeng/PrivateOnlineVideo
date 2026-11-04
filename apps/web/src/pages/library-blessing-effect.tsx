import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { BLESSING_DURATION_MS, BLESSING_REVEAL_MS, BLESSING_STATIC_MS } from "./library-blessing";
import type { BlessingBurst } from "./library-blessing";
import "./library-blessing.css";

export function LibraryBlessingEffect({ burst, enabled, onFinish }: { burst: BlessingBurst; enabled: boolean; onFinish: () => void }) {
  const [revealed, setRevealed] = useState(!burst.motion);
  useEffect(() => {
    const reveal = burst.motion ? window.setTimeout(() => setRevealed(true), BLESSING_REVEAL_MS) : undefined;
    const finish = window.setTimeout(onFinish, burst.motion ? BLESSING_DURATION_MS : BLESSING_STATIC_MS);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { if (!document.querySelector("dialog[open]")) event.preventDefault(); onFinish(); } };
    const hidden = () => { if (document.visibilityState === "hidden") onFinish(); };
    document.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", onFinish);
    return () => {
      if (reveal !== undefined) clearTimeout(reveal);
      clearTimeout(finish);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", onFinish);
    };
  }, [burst, onFinish]);
  useEffect(() => { if (burst.motion && !enabled) onFinish(); }, [enabled, burst, onFinish]);

  // 非模态装饰层：不锁滚动、不修改 body 样式，关闭或卸载后页面自然恢复。
  return createPortal(<div className="library-blessing-effect" role="region" aria-label="祝福彩蛋" data-motion={burst.motion} data-phase={revealed ? "blessing" : "rain"} style={{ "--blessing-duration": `${BLESSING_DURATION_MS}ms` } as CSSProperties}>
    <div className="library-blessing-meteors" aria-hidden="true">
      {burst.meteors.map((meteor, index) => <span className="library-blessing-meteor" key={index} style={{ left: meteor.x, top: meteor.y, "--meteor-dx": `${meteor.dx}px`, "--meteor-dy": `${meteor.dy}px`, "--meteor-angle": `${meteor.angle}deg`, "--meteor-duration": `${meteor.duration}ms`, "--meteor-delay": `${meteor.delay}ms`, "--meteor-color": meteor.color } as CSSProperties}><i /></span>)}
    </div>
    {revealed && <div className="library-blessing-center">
      {burst.motion && <div className="library-blessing-explosion" aria-hidden="true">
        <i className="library-blessing-ring" /><i className="library-blessing-ring secondary" />
        {burst.rays.map((ray, index) => <i className="library-blessing-ray" key={index} style={{ "--ray-x": `${ray.x}vmin`, "--ray-y": `${ray.y}vmin`, "--ray-angle": `${ray.angle}deg`, "--ray-delay": `${ray.delay}ms`, "--ray-color": ray.color } as CSSProperties} />)}
      </div>}
      <div className="library-blessing-word" role="status" aria-label={burst.word} aria-live="polite" aria-atomic="true" data-word={burst.word} style={{ "--blessing-length": Array.from(burst.word).length } as CSSProperties}>
        <span className="library-blessing-echo cyan" aria-hidden="true">{burst.word}</span>
        <span className="library-blessing-echo gold" aria-hidden="true">{burst.word}</span>
        <span className="library-blessing-lettering" aria-hidden="true">{Array.from(burst.word).map((letter, index) => <span className="library-blessing-letter" key={index} style={{ "--letter-index": index, "--letter-tilt": `${index % 2 ? 12 : -12}deg` } as CSSProperties}>{letter}</span>)}</span>
      </div>
      <span className="library-blessing-caption" aria-hidden="true">愿所有美好，都向你奔赴而来</span>
    </div>}
    <button type="button" className="library-blessing-close" aria-label="关闭祝福彩蛋" onClick={onFinish}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button>
  </div>, document.body);
}
