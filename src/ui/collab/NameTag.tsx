/**
 * Your name, written on a name tag rather than typed into a form — the sticker everyone knows from a
 * meetup, "Hello, my name is", with the name itself as the field. It is what others see beside your
 * cursor, and the scene above picks up the initials as they are typed.
 */
export function NameTag({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="dc-nametag">
      <span className="dc-nametag-lead">Hello, my name is</span>
      <input
        aria-label="Your name"
        value={value}
        maxLength={40}
        autoFocus
        autoComplete="nickname"
        spellCheck={false}
        placeholder="your name"
        size={Math.max(value.length + 1, 10)}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
