import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  AlertDialog,
  Badge,
  Box,
  Button as RadixButton,
  Callout,
  Card as RadixCard,
  Checkbox,
  DropdownMenu,
  Flex,
  Heading,
  IconButton,
  Progress,
  RadioGroup,
  Select as RadixSelect,
  TabNav,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { announce, claimPageFocus } from "./a11y.tsx";
import type { Project } from "./api.ts";
import { Link } from "./router.tsx";
import { setFormDirty } from "./unsaved.ts";
import { appName, setPageTitle } from "./theme.ts";
import { HELP_CENTER_URL } from "../shared/product.ts";

// The building blocks every screen uses, on Radix Themes.

/**
 * The size of fields, drop-downs and buttons in the app: 32px on a computer (Radix size 2),
 * 40px on a phone (size 3) for fingers. The signed-out screens keep size 3 throughout.
 */
export const CONTROL_SIZE = { initial: "3", sm: "2" } as const;
type ControlSize = "1" | "2" | "3" | typeof CONTROL_SIZE;

// True inside AuthCard, whose forms keep the larger controls.
const SignedOutForm = createContext(false);
export const useControlSize = (): ControlSize => (useContext(SignedOutForm) ? "3" : CONTROL_SIZE);

/**
 * For a page's h1: sets the browser tab's title and lets the heading take focus
 * after a page change. Give the returned ref to the h1, with tabIndex={-1}.
 */
export function usePageHeading(title: string | undefined) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (title) setPageTitle(title);
  }, [title]);
  // After every render, because the same heading can stay in place while the page changes under it.
  useEffect(() => claimPageFocus(ref.current));
  return ref;
}

// ---- Icons (decorative; the control around them has the name) ----

type IconProps = { size?: number };
const icon = (size: number, path: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
    {path}
  </svg>
);
export const ChevronLeft = ({ size = 16 }: IconProps) => icon(size, <path d="M10 3 5 8l5 5" />);
export const ChevronRight = ({ size = 16 }: IconProps) => icon(size, <path d="m6 3 5 5-5 5" />);
export const InfoIcon = ({ size = 16 }: IconProps) =>
  icon(size, <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v3.6M8 5v.1" /></>);
export const HelpIcon = ({ size = 16 }: IconProps) =>
  icon(size, <><circle cx="8" cy="8" r="6.2" /><path d="M6.3 6.5a1.7 1.7 0 1 1 2.5 1.5c-.5.3-.8.6-.8 1.2M8 11.3v.1" /></>);
export const MoreIcon = ({ size = 16 }: IconProps) =>
  icon(size, <g fill="currentColor" stroke="none"><circle cx="3.25" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.75" cy="8" r="1.25" /></g>);

// ---- Text ----

/** A running time shown large, in tabular figures so it doesn't jiggle as it ticks. The timer role keeps it from being read out every second. */
export function Clock({ time }: { time: string }) {
  return (
    <span role="timer" className="wl-clock">
      {time}
    </span>
  );
}

/** Text only screen readers get, to tell apart buttons that look the same ("Edit" next to a client's name). */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="wl-sr-only">{children}</span>;
}

/** A name shortened for use in a label, such as the notes of a time entry. */
export const brief = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

// An "add" form's error should not outlive the next thing the person does on the page.
// Anything on the page that starts an action calls actionStarted(); forms that show an error
// of their own clear it with useClearOnAction.
const actionListeners = new Set<() => void>();
/** Says that something else on the page is starting (a row's save, an archive, a rename). */
export const actionStarted = () => actionListeners.forEach((listener) => listener());
/** Runs `clear` whenever another action starts on the page. */
export function useClearOnAction(clear: () => void) {
  const latest = useRef(clear);
  latest.current = clear;
  useEffect(() => {
    const listener = () => latest.current();
    actionListeners.add(listener);
    return () => void actionListeners.delete(listener);
  }, []);
}

/** The id of a form's InlineError. Pass it to the form's Fields as `errorId` while the message shows. */
export const FORM_ERROR_ID = "form-error";

// ---- Page structure ----

/** The address of a Help Center article, given its path under /help. */
export const helpUrl = (article: string) => `${import.meta.env.VITE_HELP_CENTER_URL || HELP_CENTER_URL}/${article}`;

/** A "?" next to a page's title: the Help Center article about that page, in a new tab. */
export function HelpLink({ article, label = "Help for this page" }: { article: string; /** For a second "?" on a page, about one part of it. */ label?: string }) {
  return (
    <IconButton asChild variant="outline" color="gray" size="2" radius="full">
      <a href={helpUrl(article)} target="_blank" rel="noreferrer" aria-label={`${label} (opens in a new tab)`}>
        <HelpIcon />
      </a>
    </IconButton>
  );
}

/** A link in running text to a Help Center article (its path under /help), in a new tab. */
export function ArticleLink({ article, children }: { article: string; children: ReactNode }) {
  return (
    <a href={helpUrl(article)} target="_blank" rel="noreferrer" className="wl-link">
      {children}
      <SrOnly> (opens in a new tab)</SrOnly>
    </a>
  );
}

/**
 * The top of every page. `eyebrow` is a short line above the title naming the section;
 * `docTitle` is the browser tab's title when the heading isn't plain text; `help` is the
 * Help Center article for the page (its path under /help).
 */
export function PageHeader({ eyebrow, title, docTitle, intro, help, children }: { eyebrow?: ReactNode; title: ReactNode; docTitle?: string; intro?: ReactNode; help?: string; children?: ReactNode }) {
  const heading = usePageHeading(docTitle ?? (typeof title === "string" ? title : undefined));
  return (
    <div className="wl-page-header">
      <Box minWidth="0">
        {eyebrow && <p className="wl-eyebrow">{eyebrow}</p>}
        <Flex align="center" gap="3" wrap="wrap">
          <Heading ref={heading} as="h1" tabIndex={-1} size="6">
            {title}
          </Heading>
          {help && <HelpLink article={help} />}
        </Flex>
        {intro && (
          <Text as="p" size="2" color="gray" mt="1">
            {intro}
          </Text>
        )}
      </Box>
      {children && <div className="wl-page-actions">{children}</div>}
    </div>
  );
}

/** A bordered box, for a list, a document or a preview only (forms and settings sit on the page). Padding is up to the content, or add `padded`. */
export function Card({ children, className = "", padded = false, ...rest }: { children: ReactNode; className?: string; padded?: boolean } & Omit<ComponentProps<typeof RadixCard>, "children" | "className">) {
  return (
    <RadixCard {...rest} className={`wl-card ${padded ? "wl-card-padded" : ""} ${className}`}>
      {children}
    </RadixCard>
  );
}

/** A bar showing how much of something is used. Turns red when it goes over. */
/**
 * A thin bar. Neutral ink by default, so a customer's accent (a red or yellow brand) never reads as
 * a warning; `budget` bars turn amber from 80% and red over 100%.
 */
/** Neutral ink, except a budget's: amber from its 80% alert, red once it's over. More hours than expected isn't an error (QA2-27). */
export function ProgressBar({ value, max, label, budget = false }: { value: number; max: number; label: string; budget?: boolean }) {
  const share = max > 0 ? value / max : 0;
  const color = !budget ? "gray" : share > 1 ? "red" : share >= 0.8 ? "amber" : "gray";
  return <Progress aria-label={label} value={Math.min(max, value)} max={max} color={color} highContrast={color === "gray"} size="2" />;
}

/** A row of key numbers on a light gray band, divided by hairlines (`band={false}`: between two hairlines only). */
export function Stats({ band = true, children }: { band?: boolean; children: ReactNode }) {
  return <div className={band ? "wl-stats wl-stats-band" : "wl-stats"}>{children}</div>;
}

export function Stat({ label, value, large, children }: { label: string; value: ReactNode; large?: boolean; children?: ReactNode }) {
  return (
    <Flex direction="column" gap="1" minWidth="0">
      <Text as="p" size="2" color="gray" weight="medium">
        {label}
      </Text>
      <Text as="p" size={large ? { initial: "6", sm: "7" } : "5"} weight="bold" className="wl-num wl-stat-value">
        {value}
      </Text>
      {children}
    </Flex>
  );
}

/** The signed-out screens: sign in, set up, accept an invite. Single-purpose pages: a heading, a line, a form, all on the page (no box). `docTitle` is the browser tab's title when it should differ from the heading (the tab always adds the app name). */
export function AuthCard({ title, docTitle, intro, logoUrl, footer, children }: { title: string; docTitle?: string; intro: ReactNode; logoUrl?: string; footer?: ReactNode; children: ReactNode }) {
  const heading = usePageHeading(docTitle ?? title);
  return (
    <main id="main" className="wl-auth">
      <div className="wl-auth-inner">
        {logoUrl ? <img src={logoUrl} alt="" className="wl-auth-logo" /> : <p className="wl-auth-brand">{appName()}</p>}
        <Heading ref={heading} as="h1" tabIndex={-1} size="6" mb="2">
          {title}
        </Heading>
        <div className="wl-auth-intro">{intro}</div>
        <SignedOutForm.Provider value={true}>{children}</SignedOutForm.Provider>
        {footer && (
          <Text as="p" size="1" color="gray" align="center" mt="4" mx="2">
            {footer}
          </Text>
        )}
      </div>
    </main>
  );
}

// ---- Forms ----

// The hint sits outside the label, so the field's name is just its label; the hint
// and any error are its description. `invalid` marks a field the error is about.
export function Field({ label, hint, errorId, invalid, ...input }: { label: string; hint?: string; errorId?: string; invalid?: boolean } & Omit<ComponentProps<typeof TextField.Root>, "size" | "id" | "color" | "label">) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const size = useControlSize();
  return (
    <Box mb="4">
      <label htmlFor={id} className="wl-label">
        {label}
      </label>
      <TextField.Root
        {...input}
        id={id}
        size={size}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={invalid || undefined}
      />
      {hint && (
        <Text as="p" id={hintId} size="1" color="gray" mt="1">
          {hint}
        </Text>
      )}
    </Box>
  );
}

type ActionButtonProps = Omit<ComponentProps<typeof RadixButton>, "disabled" | "loading"> & {
  /** Working on it: dimmed, ignores clicks, and keeps keyboard focus. */
  busy?: boolean;
  /** Not available right now. Same look and behavior as busy. */
  disabled?: boolean;
  /** Shown in place of the label while busy. */
  busyLabel?: string;
};

// A busy button stays focusable (aria-disabled, not disabled), so keyboard focus isn't thrown to the top of the page.
export function ActionButton({ busy, disabled, busyLabel, children, onClick, size = CONTROL_SIZE, ...rest }: ActionButtonProps) {
  const blocked = busy || disabled;
  return (
    <RadixButton {...rest} size={size} aria-disabled={blocked || undefined} onClick={blocked ? undefined : onClick}>
      {busy && busyLabel ? busyLabel : children}
    </RadixButton>
  );
}

/** The one big button of a signed-out form. */
export function Button(props: ActionButtonProps) {
  return <ActionButton size="3" busyLabel="Please wait…" {...props} style={{ width: "100%", ...props.style }} />;
}

export type Choice = { value: string; label: string };
export type ChoiceGroup = { label?: string; choices: Choice[] };

/** Projects grouped under their client, for a drop-down. */
export function projectGroups(projects: Project[]): ChoiceGroup[] {
  const groups = new Map<string, ChoiceGroup>();
  for (const p of projects) {
    const key = p.client?.id ?? "";
    if (!groups.has(key)) groups.set(key, { label: p.client?.name ?? "No client", choices: [] });
    groups.get(key)!.choices.push({ value: p.id, label: `${p.name}${p.archived ? " (archived)" : ""}` });
  }
  return [...groups.values()];
}

// Radix does not allow an empty string as a choice's value, so "no choice" travels as this.
const NONE = "__none__";

/**
 * A drop-down list. Give it a `label` (shown above) or an `aria-label`. Choices may
 * be grouped. An empty value stands for "nothing chosen": a choice with value ""
 * (such as "No task") or the placeholder.
 */
export function Select({ value, onChange, groups: groupList, options, label, hint, placeholder, size: chosenSize, autoFocus, disabled, id, className, ...aria }: {
  value: string;
  onChange: (value: string) => void;
  groups?: ChoiceGroup[];
  /** A plain list, when there are no groups. */
  options?: Choice[];
  label?: string;
  /** Help text under the list. */
  hint?: ReactNode;
  placeholder?: string;
  size?: ControlSize;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const ownId = useId();
  const triggerId = id ?? ownId;
  const fallbackSize = useControlSize();
  const size = chosenSize ?? fallbackSize;
  const groups = groupList ?? [{ choices: options ?? [] }];
  const hintId = `${triggerId}-hint`;
  const hasEmptyChoice = groups.some((g) => g.choices.some((c) => c.value === ""));
  return (
    <Box minWidth="0">
      {label && (
        <label htmlFor={triggerId} className="wl-label">
          {label}
        </label>
      )}
      <RadixSelect.Root value={value === "" ? (hasEmptyChoice ? NONE : "") : value} onValueChange={(v) => onChange(v === NONE ? "" : v)} size={size} disabled={disabled}>
        <RadixSelect.Trigger
          id={triggerId}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={className}
          // A field with a label fills its column; one in a toolbar or a row is as wide as its text.
          style={label ? { width: "100%" } : undefined}
          aria-describedby={hint ? hintId : undefined}
          {...aria}
        />
        <RadixSelect.Content position="popper">
          {groups.map((group, i) => {
            const items = group.choices.map((c) => (
              <RadixSelect.Item key={c.value || NONE} value={c.value === "" ? NONE : c.value}>
                {c.label}
              </RadixSelect.Item>
            ));
            return group.label ? (
              <RadixSelect.Group key={group.label + i}>
                <RadixSelect.Label>{group.label}</RadixSelect.Label>
                {items}
              </RadixSelect.Group>
            ) : (
              <RadixSelect.Group key={i}>{items}</RadixSelect.Group>
            );
          })}
        </RadixSelect.Content>
      </RadixSelect.Root>
      {hint && (
        <Text as="p" id={hintId} size="1" color="gray" mt="1">
          {hint}
        </Text>
      )}
    </Box>
  );
}

// ---- Messages ----

/** A problem with a whole page or a list, above its content. */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Callout.Root role="alert" color="red" size="1">
      <Callout.Icon>
        <InfoIcon />
      </Callout.Icon>
      <Callout.Text>{message}</Callout.Text>
    </Callout.Root>
  );
}

/** Something worth reading before acting, such as a warning. Not announced; use ErrorNote for problems. */
export function Notice({ children, color = "amber", title }: { children: ReactNode; color?: "amber" | "red" | "gray"; title?: string }) {
  return (
    <Callout.Root color={color} variant="soft" size="1" highContrast>
      <Callout.Icon>
        <InfoIcon />
      </Callout.Icon>
      {/* Callout.Text is a paragraph; this may hold lists, so it is a div with the same look. */}
      <Text as="div" className="rt-CalloutText">
        {title && <strong>{title} </strong>}
        {children}
      </Text>
    </Callout.Root>
  );
}

/** A problem with the form it sits in (linked to its fields through `id`). `spaced` leaves room before the button below, on signed-out forms. */
export function InlineError({ message, id, spaced }: { message: string | null; id?: string; spaced?: boolean }) {
  if (!message) return null;
  return (
    <Text as="p" id={id} role="alert" size="2" color="red" mb={spaced ? "4" : undefined} style={spaced ? { display: "block" } : undefined}>
      {message}
    </Text>
  );
}

/** "Saved." beside a Save button. */
export function SavedNote({ message }: { message: { ok: boolean; text: string; id?: string } | null }) {
  if (!message) return null;
  return message.ok ? (
    <Text as="p" size="2" color="green">
      {message.text}
    </Text>
  ) : (
    <InlineError message={message.text} id={message.id} />
  );
}

export type SaveMessage = { ok: boolean; text: string; id?: string };

/**
 * Save feedback for a form, the same everywhere. Pass the form's current values.
 * - `dirty` is true once they differ from what was last saved or loaded: keep the Save button
 *   disabled until then (SaveButton does).
 * - `save(work, announcement)` runs the request, then shows "Saved." beside the button (it goes
 *   away when the form is changed again) and says the announcement to screen readers. Errors
 *   stay inline. `work` may return the values the server settled on, so they count as saved.
 * - `markClean(values)` says what a freshly loaded form holds.
 * - `fieldOf(message)` (optional) names the field an error is about. That field is then marked
 *   invalid, tied to the message (`fieldProps(name)`), and focused (WRK-122).
 */
export function useSaveForm<T>(value: T | null, options: { fieldOf?: (message: string) => string | null } = {}) {
  const errorId = useId();
  const key = JSON.stringify(value);
  const [baseline, setBaseline] = useState(key);
  const [busy, setBusy] = useState(false);
  // A failure remembers the form it was about; changing the form clears it (outside QA-02).
  const [result, setResult] = useState<(SaveMessage & { key?: string; field?: string | null }) | null>(null);
  // An error about one field: mark it, tie it to the message, and put the cursor in it.
  const failWith = (text: string, field = options.fieldOf?.(text) ?? null) => {
    setResult({ ok: false, text, key, id: errorId, field });
    if (field) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[name="${field}"]`)?.focus());
  };
  const dirty = key !== baseline;
  // Leaving with unsaved changes asks first (see unsaved.ts).
  const formId = useRef({});
  useEffect(() => {
    setFormDirty(formId.current, dirty);
    return () => setFormDirty(formId.current, false);
  }, [dirty]);

  async function save(work: () => Promise<T | void>, announcement: string | (() => string), text = "Saved."): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setResult(null);
    try {
      const settled = await work();
      setBaseline(settled === undefined ? key : JSON.stringify(settled));
      setResult({ ok: true, text });
      announce(typeof announcement === "function" ? announcement() : announcement);
      return true;
    } catch (e) {
      failWith((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const message = result && (result.ok ? dirty : result.key !== key) ? null : result;
  const invalid = (name: string) => Boolean(message && !message.ok && message.field === name);
  return {
    dirty,
    busy,
    message,
    /** For a field: its name (so it can be focused), and whether the current error is about it. */
    fieldProps: (name: string) => ({ name, invalid: invalid(name), errorId: invalid(name) ? errorId : undefined }),
    save,
    markClean: (loaded: T | null) => setBaseline(JSON.stringify(loaded)),
    /** Shows an error that didn't come from a save, such as a form that can't be sent as typed. */
    fail: (text: string, field?: string) => failWith(text, field ?? options.fieldOf?.(text) ?? null),
  };
}

/** A form's Save button: disabled while nothing has changed, and busy while saving. */
export function SaveButton({ state, children, ...rest }: { state: { dirty: boolean; busy: boolean } } & Omit<ActionButtonProps, "busy" | "disabled" | "busyLabel" | "type">) {
  return (
    <ActionButton {...rest} type="submit" busy={state.busy} busyLabel="Saving…" disabled={!state.dirty}>
      {children}
    </ActionButton>
  );
}

export function Loading() {
  return <Text color="gray">Loading…</Text>;
}

/** What a list says when it has nothing in it: one sentence, and the primary action if there is one. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Flex direction="column" align="center" gap="3" px="4" py="6">
      <Text as="p" color="gray" align="center">
        {children}
      </Text>
      {action}
    </Flex>
  );
}

/** A heading above a list or a group of cards. `muted` is a quieter group heading ("Archived"). */
export function SectionTitle({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return muted ? (
    <Heading as="h2" size="2" weight="medium" color="gray" mb="2">
      {children}
    </Heading>
  ) : (
    <Heading as="h2" size="3" mb="2">
      {children}
    </Heading>
  );
}

// ---- More form controls ----

type FieldBase = { label: ReactNode; hint?: ReactNode; errorId?: string; invalid?: boolean };

/** A single-line field with its label above it. `suffix` is a unit shown inside the right edge ("USD"). */
export function TextInput({ label, hint, errorId, invalid, suffix, size: chosenSize, ...input }: FieldBase & { suffix?: ReactNode } & Omit<ComponentProps<typeof TextField.Root>, "id" | "label" | "color">) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const fallbackSize = useControlSize();
  const size = chosenSize ?? fallbackSize;
  return (
    <Box minWidth="0">
      <label htmlFor={id} className="wl-label">
        {label}
      </label>
      <TextField.Root {...input} id={id} size={size} aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined} aria-invalid={invalid || undefined}>
        {suffix && <TextField.Slot side="right">{suffix}</TextField.Slot>}
      </TextField.Root>
      {hint && (
        <Text as="p" id={hintId} size="1" color="gray" mt="1">
          {hint}
        </Text>
      )}
    </Box>
  );
}

export function TextAreaInput({ label, hint, errorId, invalid, size: chosenSize, ...input }: FieldBase & Omit<ComponentProps<typeof TextArea>, "id" | "label" | "color">) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const fallbackSize = useControlSize();
  const size = chosenSize ?? fallbackSize;
  return (
    <Box minWidth="0">
      <label htmlFor={id} className="wl-label">
        {label}
      </label>
      <TextArea {...input} id={id} size={size} aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined} aria-invalid={invalid || undefined} />
      {hint && (
        <Text as="p" id={hintId} size="1" color="gray" mt="1">
          {hint}
        </Text>
      )}
    </Box>
  );
}

/** A checkbox with its label to the right. */
export function CheckField({ label, checked, onChange, disabled, hint }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  return (
    <Text as="label" size="2" className="wl-choice">
      <Flex as="span" align="start" gap="2">
        <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
        <span>
          {label}
          {hint && (
            <Text as="span" size="1" color="gray" style={{ display: "block" }}>
              {hint}
            </Text>
          )}
        </span>
      </Flex>
    </Text>
  );
}

/** One choice of a RadioGroup, with its label to the right. */
export function RadioOption({ value, children, hint, disabled }: { value: string; children: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <Text as="label" size="2" className="wl-choice" color={disabled ? "gray" : undefined}>
      <Flex as="span" align="start" gap="2">
        <RadioGroup.Item value={value} disabled={disabled} />
        <span>
          {children}
          {hint && (
            <Text as="span" size="1" color="gray" style={{ display: "block" }}>
              {hint}
            </Text>
          )}
        </span>
      </Flex>
    </Text>
  );
}

/**
 * A section of a settings page: its title and a line about it on the left (above, on a phone),
 * its controls on the right. Sections that follow one another are divided by a hairline.
 */
export function SettingsSection({ title, description, headingId, children }: { title: string; description?: ReactNode; headingId?: string; children: ReactNode }) {
  const ownId = useId();
  const id = headingId ?? ownId;
  return (
    <section className="wl-settings-section" aria-labelledby={id}>
      <div>
        <Heading as="h2" size="3" id={id}>
          {title}
        </Heading>
        {description && (
          <Text as="p" size="2" color="gray" mt="1">
            {description}
          </Text>
        )}
      </div>
      <Flex direction="column" gap="4" minWidth="0">
        {children}
      </Flex>
    </section>
  );
}

/** A titled group of related fields in a form. (Settings pages move to SettingsSection.) */
export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="wl-fieldset">
      <legend className="wl-legend">{title}</legend>
      <Flex direction="column" gap="3">
        {children}
      </Flex>
    </fieldset>
  );
}

/**
 * A button that opens the computer's file chooser. The file input itself stays out of
 * sight (people use this button, which always shows where focus is), and the chosen
 * file arrives through `onFile`.
 */
export function FileButton({ accept, onFile, children, busy, ...rest }: { accept: string; onFile: (file: File) => void; children: ReactNode; busy?: boolean } & Omit<ActionButtonProps, "onClick" | "children">) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <ActionButton type="button" variant="outline" color="gray" {...rest} busy={busy} onClick={() => input.current?.click()}>
        {children}
      </ActionButton>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared, so choosing the same file again still counts as a change.
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}

// ---- Rows and tables ----

/** A list of rows inside a Card, divided by hairlines. */
export function Rows({ children }: { children: ReactNode }) {
  return <ul className="wl-rows">{children}</ul>;
}

/** One row. `editing` gives it the tinted background of an open editor. */
export function Row({ editing, className = "", ...rest }: { editing?: boolean } & ComponentProps<"li">) {
  return <li {...rest} className={`wl-row ${editing ? "wl-editor" : ""} ${className}`} />;
}

/** The left, growing part of a row: its name and details. */
export function RowMain({ children }: { children: ReactNode }) {
  return <div className="wl-row-main">{children}</div>;
}

/** The buttons at the right of a row. */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="wl-row-actions">{children}</div>;
}

/**
 * A quiet text button: Edit or Restore on a row, Cancel beside Save, Delete (`danger`, in red) at the far left of a form.
 * `flush` is for one that stands alone under a form or list: its text lines up with the left edge of what is above it.
 */
export function RowButton({ danger, flush, className = "", ...props }: ActionButtonProps & { danger?: boolean; flush?: boolean }) {
  return <ActionButton variant="ghost" color={danger ? "red" : "gray"} size="2" {...props} className={`wl-text-button${flush ? " wl-text-button-flush" : ""} ${className}`} />;
}

/** The same as RowButton, for a link to another page. */
export function RowLink({ to, children, ...rest }: { to: string; children: ReactNode } & Omit<ComponentProps<typeof Link>, "to">) {
  return (
    <ActionButton asChild variant="ghost" color="gray" size="2" className="wl-text-button">
      <Link to={to} {...rest}>
        {children}
      </Link>
    </ActionButton>
  );
}

// Runs a menu item's action once the menu has closed (see RowMenu).
const RowMenuAction = createContext<(action: () => void) => void>((action) => action());

/**
 * A row's less frequent actions (Archive, Delete) behind one "More actions" button. Give it a
 * `label` that names the row ("More actions for Acme Ltd"). An item's action runs once the menu
 * has closed and focus is back on this button, so a confirm dialog it opens returns focus here.
 */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const pending = useRef<(() => void) | null>(null);
  const later = useCallback((action: () => void) => {
    pending.current = action;
  }, []);
  return (
    // Not modal: the rest of the page stays visible to assistive technology while the menu is open.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger>
        <IconButton variant="ghost" color="gray" size="2" className="wl-text-button" aria-label={label}>
          <MoreIcon />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        align="end"
        size="2"
        onCloseAutoFocus={() => {
          const action = pending.current;
          pending.current = null;
          if (action) window.setTimeout(action, 0);
        }}
      >
        <RowMenuAction.Provider value={later}>{children}</RowMenuAction.Provider>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/** One action in a RowMenu. `danger` shows it in red (it should still ask before deleting). */
export function RowMenuItem({ onSelect, danger, disabled, children }: { onSelect: () => void; danger?: boolean; disabled?: boolean; children: ReactNode }) {
  const later = useContext(RowMenuAction);
  return (
    <DropdownMenu.Item color={danger ? "red" : undefined} disabled={disabled} onSelect={() => later(onSelect)}>
      {children}
    </DropdownMenu.Item>
  );
}

/**
 * Where a wide table scrolls sideways on a small screen. It can be focused, so keyboard
 * users can scroll it, and it has a name. (Radix's Table brings a scroll area of its own;
 * the stylesheet turns that off so this one scrolls instead.)
 */
export function TableRegion({ label, children, minWidth = "32rem" }: { label: string; children: ReactNode; minWidth?: string }) {
  const region = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  // When columns are out of view to the right, a fade and a hint say so.
  useEffect(() => {
    const box = region.current;
    if (!box) return;
    const check = () => setMoreRight(box.scrollWidth - box.clientWidth - box.scrollLeft > 4);
    check();
    box.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    observer?.observe(box);
    if (box.firstElementChild) observer?.observe(box.firstElementChild);
    return () => {
      box.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, []);
  return (
    <div className="wl-table-frame">
      <div ref={region} role="region" aria-label={label} tabIndex={0} className="wl-scroller wl-table" style={{ ["--wl-table-min" as string]: minWidth }}>
        {children}
      </div>
      {moreRight && <div aria-hidden className="wl-table-fade" />}
      {moreRight && (
        <Text as="p" size="1" color="gray" className="wl-table-hint" aria-hidden>
          Scroll sideways for more columns
        </Text>
      )}
    </div>
  );
}

/**
 * The tabs under a page's title (a project's sections, the Manage sections). They stay on one
 * row; when they don't fit, the row scrolls sideways inside its own labeled region (keyboard
 * users can focus it, and moving focus along the tabs scrolls too), with the current tab in view.
 */
export function NavTabs({ label, tabs }: { label: string; tabs: { to: string; label: ReactNode; active: boolean }[] }) {
  const region = useRef<HTMLDivElement>(null);
  // A fade at an edge says there are more tabs that way.
  const [more, setMore] = useState({ left: false, right: false });
  // The box is a focusable, labeled region only while the tabs really overflow; otherwise it is a plain div (no empty Tab stop).
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const box = region.current;
    if (!box) return;
    const check = () => {
      setOverflowing(box.scrollWidth > box.clientWidth);
      setMore({ left: box.scrollLeft > 4, right: box.scrollWidth - box.clientWidth - box.scrollLeft > 4 });
    };
    check();
    box.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    observer?.observe(box);
    if (box.firstElementChild) observer?.observe(box.firstElementChild);
    return () => {
      box.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, []);
  const current = tabs.find((t) => t.active)?.to;
  useEffect(() => {
    const box = region.current;
    const tab = box?.querySelector<HTMLElement>("[data-active]");
    if (!box || !tab || box.scrollWidth <= box.clientWidth) return;
    // Scrolls the box itself, not the page.
    box.scrollLeft = tab.offsetLeft - (box.clientWidth - tab.offsetWidth) / 2;
  }, [current]);
  return (
    <div className="wl-tabs-frame">
      <div
        ref={region}
        {...(overflowing ? { role: "region", "aria-label": `${label}, scrolls sideways`, tabIndex: 0 } : {})}
        className="wl-scroller wl-tabs"
      >
        <TabNav.Root aria-label={label} size="2">
          {tabs.map((tab) => (
            <TabNav.Link key={tab.to} asChild active={tab.active}>
              <Link to={tab.to}>{tab.label}</Link>
            </TabNav.Link>
          ))}
        </TabNav.Root>
      </div>
      {more.left && <div aria-hidden data-tabs-fade="left" className="wl-tabs-fade wl-tabs-fade-left" />}
      {more.right && <div aria-hidden data-tabs-fade="right" className="wl-tabs-fade wl-tabs-fade-right" />}
    </div>
  );
}

// ---- Invoice status ----

export type StatusKind = "draft" | "sent" | "paid" | "overdue";
const STATUS: Record<StatusKind, { label: string; color: "gray" | "amber" | "green" | "red" }> = {
  draft: { label: "Draft", color: "gray" },
  sent: { label: "Sent", color: "amber" },
  paid: { label: "Paid", color: "green" },
  overdue: { label: "Overdue", color: "red" },
};

/** Gray draft, amber sent, green paid, red overdue. Always a word, never only a color. */
export function StatusBadge({ status }: { status: StatusKind }) {
  const { label, color } = STATUS[status];
  return (
    <Badge color={color} variant="soft" size="2" highContrast>
      {label}
    </Badge>
  );
}

// ---- Asking before something is deleted ----

type Question = { title: string; description: ReactNode; confirm: string; danger?: boolean; /** The label of the button that changes nothing. */ cancel?: string };
type Ask = (question: Question) => Promise<boolean>;
const ConfirmContext = createContext<Ask>(() => Promise.resolve(false));

/**
 * Asks "are you sure?" in a dialog and answers true or false:
 *   if (!(await confirm({ title: "Delete Brand refresh?", confirm: "Delete" }))) return;
 * The dialog starts on Cancel, keeps focus inside, closes with Escape, and puts focus
 * back where it was (or, when that button is gone by then, on the page's heading).
 */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState<Question | null>(null);
  const answer = useRef<((ok: boolean) => void) | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const ask = useCallback<Ask>((q) => {
    // A second question while one is open means "no" to the first.
    answer.current?.(false);
    return new Promise<boolean>((resolve) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      answer.current = resolve;
      setQuestion(q);
      setOpen(true);
    });
  }, []);

  function settle(ok: boolean) {
    answer.current?.(ok);
    answer.current = null;
    setOpen(false);
  }

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <AlertDialog.Root open={open} onOpenChange={(next) => !next && settle(false)}>
        <AlertDialog.Content
          maxWidth="26rem"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const back = opener.current;
            opener.current = null;
            if (back?.isConnected) back.focus();
          }}
        >
          <AlertDialog.Title size="4">{question?.title}</AlertDialog.Title>
          <AlertDialog.Description size="2">{question?.description}</AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel>
              <RadixButton variant="ghost" color="gray" size="2" className="wl-text-button">
                {question?.cancel ?? "Cancel"}
              </RadixButton>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <RadixButton color={question?.danger === false ? undefined : "red"} size="2" onClick={() => settle(true)}>
                {question?.confirm}
              </RadixButton>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}
