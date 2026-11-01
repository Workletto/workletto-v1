import { expect, test } from "@playwright/test";
import { choose, seedProject, today, unique } from "./helpers.ts";
import { seedEntry } from "./helpers.ts";

// QA2-24: where the Today marker sits, and how the chart names its months.
test("the Today marker is at the right edge of today's bar, and months read Jan, Feb", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Chart Project") });
  await seedEntry(request, { projectId: project.id, date: today(), minutes: 90 });

  await page.goto("/reports");
  const svg = page.locator("svg.wl-chart-svg");
  await expect(svg).toBeVisible();
  // "most on Oct 14 (6:30)" for days.
  await expect(svg).toHaveAttribute("aria-label", /, most on [A-Z][a-z]{2} \d{1,2} \(\d+:\d{2}\)\.$/);

  const marker = page.locator(".wl-chart-today");
  await expect(marker).toBeVisible();
  const geometry = await page.evaluate(() => {
    const chart = document.querySelector("svg.wl-chart-svg")!;
    const box = chart.getBoundingClientRect();
    const buckets = chart.querySelectorAll("rect.wl-chart-billable").length;
    const tag = document.querySelector(".wl-chart-today")!;
    const edge = tag.getAttribute("data-edge") === "end";
    const t = tag.getBoundingClientRect();
    // The line is the tag's center, or its right edge when the tag hangs back inside at the end of the chart.
    const lineX = edge ? t.right : t.left + t.width / 2;
    return { buckets, lineShare: (lineX - box.left) / box.width, index: Number(document.querySelector(".wl-chart-today")!.getAttribute("style")!.match(/left: ([\d.]+)%/)![1]) };
  });
  // The browser runs in UTC (playwright.config.ts), as does today(): count the day the same way.
  const index = new Date().getUTCDate() - 1;
  expect(geometry.buckets).toBeGreaterThan(27);
  expect(geometry.lineShare).toBeCloseTo((index + 1) / geometry.buckets, 1);
  expect(geometry.index / 100).toBeCloseTo((index + 1) / geometry.buckets, 3);

  // Months: "Jan", never "Jan 26", and the summary names the month and year in full.
  await choose(page.getByRole("combobox", { name: "Period" }), "This year");
  const year = String(new Date().getFullYear());
  await expect(svg).toHaveAttribute("aria-label", new RegExp(`, most in [A-Z][a-z]+ ${year} \\(\\d+:\\d{2}\\)\\.$`));
  await expect(page.locator(".wl-chart-axis span").first()).toHaveText("Jan");
  await expect(page.locator(".wl-chart-today")).toHaveCount(0);
});
