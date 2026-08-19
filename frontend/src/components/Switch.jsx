// A true toggle: the whole control is one button, so clicking anywhere on it
// (track or knob) flips the state.
export default function Switch({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? " on" : ""}`}
      data-on={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
