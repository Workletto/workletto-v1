import { useEffect, useRef, useState } from "react";
import { Badge, Flex, SegmentedControl, Text, TextField } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import { api, type Me } from "../api.ts";
import { applyLook, type Look } from "../theme.ts";
import { accentColors, COLOR_MODES, DEFAULT_ACCENT, HEX_COLOR } from "../../shared/color.ts";
import { LOGO_TYPES, MAX_LOGO_BYTES } from "../../shared/limits.ts";
import { Brand, ManageTabs } from "../Shell.tsx";
import { NAV_ICONS } from "../icons.tsx";
import { ActionButton, CONTROL_SIZE, FileButton, InlineError, Notice, PageHeader, RowButton, SavedNote, SettingsSection, SrOnly } from "../ui.tsx";

// The built-in accent, shown in the picker while no color is chosen.
const DEFAULT_SWATCH = DEFAULT_ACCENT;
const MODE_LABELS = { system: "System", light: "Light", dark: "Dark" } as const;

/**
 * Tells the admin when their color isn't readable as text or as a focus outline in a
 * mode people will see, and was adjusted there (buttons keep the exact color).
 */
function readabilityNote({ accentColor, colorMode }: Look): string | null {
  if (!accentColor) return null;
  const shown = accentColors(accentColor).adjustedModes.filter((mode) => colorMode === "system" || colorMode === mode);
  if (shown.length === 0) return null;
  const shades = shown.map((mode) => (mode === "light" ? "a darker shade of this color in light mode" : "a lighter shade of this color in dark mode"));
  return `To stay readable, links and focus outlines use ${shades.join(" and ")}. Buttons keep the exact color.`;
}

// Changes show across the whole app straight away (the live preview).
// Leaving without saving puts the saved look back.
type OrgChanges = Partial<Pick<Me["organization"], "accentColor" | "colorMode" | "logoVersion">>;

export function Appearance({ me, onSaved }: { me: Me; onSaved: (changes: OrgChanges) => void }) {
  const saved = useRef<Look>({ accentColor: me.organization.accentColor, colorMode: me.organization.colorMode });
  const [look, setLook] = useState<Look>(saved.current);
  const [hexText, setHexText] = useState(look.accentColor ?? "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const hexField = useRef<HTMLInputElement>(null);
  // A code that isn't a color is called out once the person leaves the box.
  const [hexLeft, setHexLeft] = useState(false);
  const hexInvalid = hexLeft && hexText.trim() !== "" && !HEX_COLOR.test(hexText);

  useEffect(() => applyLook(look), [look]);
  useEffect(() => () => applyLook(saved.current), []);

  const dirty = look.accentColor !== saved.current.accentColor || look.colorMode !== saved.current.colorMode;
  const readability = readabilityNote(look);
  // Said once the color stops changing, so dragging the color picker doesn't read out every step.
  useEffect(() => {
    if (!readability) return;
    const timer = window.setTimeout(() => announce(readability), 800);
    return () => window.clearTimeout(timer);
  }, [readability]);

  function setAccent(value: string | null) {
    setMessage(null);
    setHexText(value ?? "");
    setLook((l) => ({ ...l, accentColor: value?.toLowerCase() ?? null }));
  }

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setMessage(null);
    try {
      saved.current = await api<Look>("/api/settings/appearance", look, "PUT");
      onSaved(saved.current);
      setMessage({ ok: true, text: "Saved. Everyone in your organization now sees this look." });
      announce("Appearance saved.");
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Appearance" intro="Choose your logo, accent color and light or dark mode. You see changes as you make them." help="customization/brand-your-app" />
      <ManageTabs role="admin" />

      <LogoSettings logoVersion={me.organization.logoVersion} onChange={(logoVersion) => onSaved({ logoVersion })} />

      <SettingsSection title="Accent color" description="Buttons, links, the current page and focus outlines use it.">
        <Flex wrap="wrap" align="center" gap="3">
          <input
            type="color"
            aria-label="Pick an accent color"
            value={look.accentColor ?? DEFAULT_SWATCH}
            onChange={(e) => setAccent(e.target.value)}
            className="wl-color"
          />
          <TextField.Root
            ref={hexField}
            size={CONTROL_SIZE}
            aria-label="Accent color as a hex code"
            placeholder="#2b4a78"
            value={hexText}
            spellCheck={false}
            aria-invalid={hexInvalid || undefined}
            aria-describedby={hexInvalid ? "hex-error" : undefined}
            onBlur={() => setHexLeft(true)}
            onChange={(e) => {
              setHexText(e.target.value);
              if (HEX_COLOR.test(e.target.value)) setAccent(e.target.value);
            }}
            className="wl-mono"
            style={{ width: "9rem" }}
          />
          {look.accentColor === null ? (
            <Text size="2" color="gray">Default</Text>
          ) : (
            <RowButton
              type="button"
              onClick={() => {
                setAccent(null);
                // The button goes away, so focus moves to the color it reset.
                hexField.current?.focus();
              }}
            >
              Reset to default
            </RowButton>
          )}
        </Flex>
        <InlineError id="hex-error" message={hexInvalid ? "Enter a color like #2f5bd3." : null} />
      </SettingsSection>

      <SettingsSection title="Mode" description="System follows each person's device setting." headingId="mode-heading">
        <SegmentedControl.Root aria-labelledby="mode-heading" size={CONTROL_SIZE} value={look.colorMode} onValueChange={(mode) => setLook((l) => ({ ...l, colorMode: mode as Look["colorMode"] }))} style={{ alignSelf: "start" }}>
          {COLOR_MODES.map((mode) => (
            <SegmentedControl.Item key={mode} value={mode}>{MODE_LABELS[mode]}</SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>
      </SettingsSection>

      <SettingsSection title="Preview" description="How the app looks with these choices.">
        {/* A picture of the look: nothing in it can be used. */}
        {/* The app's own shell in small: the sidebar with your logo and name, the current page, the white sheet (QA2-16). */}
        <div inert className="wl-preview">
          <div className="wl-preview-side">
            <Brand me={me} />
            <div className="wl-preview-nav">
              <span className="wl-navlink" aria-current="page">{NAV_ICONS.time}Time</span>
              <span className="wl-navlink">{NAV_ICONS.projects}Projects</span>
              <span className="wl-navlink">{NAV_ICONS.reports}Reports</span>
            </div>
          </div>
          <Flex direction="column" gap="4" p="4" className="wl-preview-sheet">
            <Flex wrap="wrap" align="center" justify="between" gap="3">
              <Text size="2">
                <Text weight="medium">Brand refresh</Text> <Text color="gray">· Studio site</Text>
              </Text>
              <Flex align="center" gap="3">
                <Badge color="green" variant="soft" size="2">Running</Badge>
                <Text size="2" weight="medium" className="wl-num">1:45</Text>
              </Flex>
            </Flex>
            <Flex wrap="wrap" align="center" gap="4">
              <ActionButton>Start timer</ActionButton>
              <Text size="2" className="wl-link">View timesheet</Text>
            </Flex>
          </Flex>
        </div>
        {readability && <Notice color="gray">{readability}</Notice>}
      </SettingsSection>

      <Flex wrap="wrap" align="center" justify="end" gap="3" className="wl-form-footer">
        <SavedNote message={message} />
        {dirty && (
          <RowButton
            type="button"
            onClick={() => {
              setLook(saved.current);
              setHexText(saved.current.accentColor ?? "");
            }}
          >
            Undo changes
          </RowButton>
        )}
        <ActionButton onClick={save} disabled={!dirty} busy={busy} busyLabel="Saving…">Save appearance</ActionButton>
      </Flex>
    </>
  );
}

// The logo uploads as soon as it is chosen and appears in the header straight away.
function LogoSettings({ logoVersion, onChange }: { logoVersion: number | null; onChange: (v: number | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(method: "PUT" | "DELETE", file?: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/appearance/logo", {
        method,
        headers: file ? { "content-type": file.type } : undefined,
        body: file,
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "The logo could not be saved. Try again.");
      onChange(data.logoVersion ?? null);
      announce(method === "PUT" ? "Logo uploaded." : "Logo removed.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function choose(file: File) {
    if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return setError("Choose a PNG, JPEG or WebP image. SVG isn't supported.");
    if (file.size > MAX_LOGO_BYTES) return setError("That file is over 1 MB. Try a smaller or compressed image.");
    void send("PUT", file);
  }

  return (
    <SettingsSection title="Logo" description="PNG, JPEG or WebP, up to 1 MB. A square logo on a transparent background works best: your organization's name is shown beside it. It's saved as soon as you choose it.">
      <Flex wrap="wrap" align="center" gap="3">
        <div className="wl-logo-box">
          {logoVersion ? <img src={`/api/logo?v=${logoVersion}`} alt="Your logo" /> : <Text size="2" color="gray">No logo yet</Text>}
        </div>
        <FileButton accept={LOGO_TYPES.join(",")} onFile={choose} busy={busy} busyLabel="Uploading…">
          Choose file<SrOnly> for your logo</SrOnly>
        </FileButton>
        {logoVersion && <RowButton type="button" onClick={() => void send("DELETE")} busy={busy}>Remove<SrOnly> logo</SrOnly></RowButton>}
      </Flex>
      <InlineError message={error} />
    </SettingsSection>
  );
}
