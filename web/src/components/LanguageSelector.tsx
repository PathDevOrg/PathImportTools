import { Check, ChevronDown, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type LocaleCode, SUPPORTED_LOCALES } from "../app/i18n";

export function LanguageSelector({
  currentLocale,
  onSelect,
}: {
  currentLocale: LocaleCode;
  onSelect: (code: LocaleCode) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const currentObj = SUPPORTED_LOCALES.find((l) => l.code === currentLocale) ?? SUPPORTED_LOCALES[0];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      window.addEventListener("click", handleClickOutside);
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("click", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="lang-selector-container" ref={containerRef}>
      <button
        type="button"
        className="lang-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Language / 语言切换"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <Globe size={15} className="lang-icon" aria-hidden="true" />
        <span className="lang-code">{currentObj.short}</span>
        <ChevronDown size={12} className={`chevron-icon ${isOpen ? "rotated" : ""}`} aria-hidden="true" />
      </button>

      {isOpen ? (
        <div className="lang-dropdown" role="listbox" aria-label="Choose Language" onWheel={(e) => e.stopPropagation()}>
          {SUPPORTED_LOCALES.map((item) => (
            <button
              key={item.code}
              type="button"
              className={`lang-option ${item.code === currentLocale ? "active" : ""}`}
              role="option"
              aria-selected={item.code === currentLocale}
              onClick={() => {
                onSelect(item.code);
                setIsOpen(false);
              }}
            >
              <span className="option-label">{item.label}</span>
              {item.code === currentLocale ? <Check size={14} className="check-icon" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
