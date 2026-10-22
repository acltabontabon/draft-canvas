/** Shared by Home and About so the product mark keeps the same drawing and colours. */
export function BrandMark() {
  return (
    <svg className="dc-brand-logo" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
      <rect className="dc-brand-tile" width="32" height="32" rx="8" />
      <rect x="6" y="8" width="11" height="7" rx="2" fill="none" stroke="#5fd6c9" strokeWidth="2" />
      <rect x="15" y="18" width="11" height="7" rx="2" fill="none" stroke="#8b9099" strokeWidth="2" />
      <path d="M11.5 15.5v3.5h4" fill="none" stroke="#5fd6c9" strokeWidth="1.6" />
    </svg>
  );
}
