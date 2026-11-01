import { useEffect, useState } from "react";
import { Flex, Heading, Text } from "@radix-ui/themes";
import { api } from "./api.ts";
import { DONATE_URL, PRODUCT_NAME } from "../shared/product.ts";
import { ActionButton, Card } from "./ui.tsx";

// The one-time donation card on the Time screen (WRK-168), for admins only. The server decides
// when it shows (src/server/about.ts). Either button hides it for good, for every admin.
// Donate is a plain link to the vendor's site: the app doesn't record whether anyone donated.
export function DonationCard() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ show: boolean }>("/api/settings/about/donation")
      .then((r) => live && setShow(r.show))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    api("/api/settings/about/donation/dismiss", {}).catch(() => {});
  };
  return (
    <Card padded className="wl-donation" role="region" aria-labelledby="donation-title">
      <Heading as="h2" size="3" id="donation-title">{PRODUCT_NAME} is free, but building and running it isn’t.</Heading>
      <Text as="p" size="2" color="gray" mt="2">
        Donations pay for fixes and for hosting the {PRODUCT_NAME} website and live demo. If it’s useful to your studio,
        please consider a donation of any amount. Only admins see this, and only once.
      </Text>
      <Flex gap="3" mt="3" wrap="wrap">
        <ActionButton asChild>
          <a href={DONATE_URL} target="_blank" rel="noreferrer" onClick={dismiss}>Donate</a>
        </ActionButton>
        <ActionButton variant="soft" color="gray" onClick={dismiss}>Don’t show again</ActionButton>
      </Flex>
    </Card>
  );
}
