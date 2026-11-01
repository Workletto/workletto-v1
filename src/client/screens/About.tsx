import { useEffect, useState } from "react";
import { Flex, Heading, Text } from "@radix-ui/themes";
import { api } from "../api.ts";
import { DONATE_URL, PRODUCT_NAME } from "../../shared/product.ts";
import { ManageTabs } from "../Shell.tsx";
import { ActionButton, ErrorNote, Loading, Notice, PageHeader, SettingsSection } from "../ui.tsx";

type About = {
  version: string;
  notes: { title: string; groups: { heading: string | null; items: string[]; text: string[] }[] } | null;
  database: { migrations: number; unfinished: string[]; latest: string | null; latestAppliedAt: string | null };
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

// Manage → About (admins): the installed version, what it changed, and a diagnostics file to look into a problem with.
export function About() {
  const [about, setAbout] = useState<About | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<About>("/api/settings/about").then(setAbout, (e: Error) => setError(e.message));
  }, []);

  const db = about?.database;
  return (
    <>
      <PageHeader title="About" help="hosting-and-maintenance/about-and-diagnostics" intro="The version installed here and what it changed." />
      <ManageTabs role="admin" />
      <ErrorNote message={error} />
      {!about && !error && <Loading />}
      {about && db && (
        <>
          <SettingsSection title="Version" description="Updates come through your repository's Update app workflow. Take a backup first; each update's notes say whether it changes the database.">
            <Text as="p" size="7" weight="medium" className="wl-num">Version {about.version}</Text>
            {about.notes && (
              <Flex direction="column" gap="3">
                <Heading as="h3" size="3">{about.notes.title}</Heading>
                {about.notes.groups.map((group, i) => (
                  <Flex key={i} direction="column" gap="2">
                    {group.heading && <Heading as="h4" size="2" color="gray">{group.heading}</Heading>}
                    {group.text.map((paragraph, j) => <Text key={j} as="p" size="2">{paragraph}</Text>)}
                    {group.items.length > 0 && (
                      <ul style={{ margin: 0, paddingLeft: "1.25rem", listStyle: "disc" }}>
                        {group.items.map((item, j) => <li key={j}><Text size="2">{item}</Text></li>)}
                      </ul>
                    )}
                  </Flex>
                ))}
              </Flex>
            )}
            <Text as="p" size="2" color="gray">
              {db.migrations} database changes applied{db.latestAppliedAt ? `, the latest on ${day(db.latestAppliedAt)}` : ""}.
            </Text>
            {db.unfinished.length > 0 && (
              <Notice color="amber">
                A database change didn't finish: {db.unfinished.join(", ")}. Restore your backup, then download the diagnostics file to look into it.
              </Notice>
            )}
          </SettingsSection>

          <SettingsSection
            title="Diagnostics"
            description="Download this file when you, a developer or an AI coding assistant look into a problem. It has the app and database versions and which features are set up. No passwords, keys, addresses or business data. Nothing is sent unless you send it."
          >
            <div>
              <ActionButton asChild variant="outline" color="gray">
                <a href="/api/settings/about/diagnostics" download>Download diagnostics</a>
              </ActionButton>
            </div>
          </SettingsSection>

          {/* Quiet vendor attribution, for admins only (WRK-168): a plain link, nothing is sent. */}
          <Text as="p" size="2" color="gray">
            {PRODUCT_NAME} is free and open source. If it’s useful to your studio, you can{" "}
            <a href={DONATE_URL} target="_blank" rel="noreferrer" className="wl-link">make a donation</a>.
          </Text>
        </>
      )}
    </>
  );
}
