import { SMTPServer } from "smtp-server";

// A small mail server for tests, listening on this computer only. It keeps what it receives.
export type ReceivedMail = { from: string; to: string[]; subject: string; body: string; user?: string; password?: string };

export async function startFakeSmtp(options: { user?: string; password?: string } = {}) {
  const received: ReceivedMail[] = [];
  const server = new SMTPServer({
    authOptional: !options.user,
    disabledCommands: ["STARTTLS"], // plain connection; the tests don't need encryption
    onAuth(auth, _session, done) {
      if (auth.username === options.user && auth.password === options.password) return done(null, { user: auth.username! });
      done(new Error("Invalid username or password"));
    },
    onData(stream, session, done) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const subject = /^Subject: (.*)$/im.exec(raw)?.[1]?.trim() ?? "";
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          subject,
          body: raw,
          user: options.user,
        });
        done();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.server.address().port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
