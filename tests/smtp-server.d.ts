declare module "smtp-server" {
  export type SmtpSession = { envelope: { mailFrom: { address: string } | false; rcptTo: { address: string }[] } };
  export class SMTPServer {
    constructor(options: {
      authOptional?: boolean;
      disabledCommands?: string[];
      secure?: boolean;
      onAuth?: (auth: { username?: string; password?: string }, session: unknown, done: (err: Error | null, response?: { user: string }) => void) => void;
      onData?: (stream: NodeJS.ReadableStream, session: SmtpSession, done: (err?: Error | null) => void) => void;
    });
    listen(port: number, host: string, done?: () => void): void;
    close(done?: () => void): void;
    server: { address(): { port: number } };
  }
}
