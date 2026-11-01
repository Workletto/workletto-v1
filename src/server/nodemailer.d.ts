// The two mail packages ship no type definitions; these cover only what the app uses.
declare module "nodemailer" {
  const nodemailer: {
    createTransport(options: Record<string, unknown>): {
      sendMail(message: Record<string, unknown>): Promise<unknown>;
      close(): void;
    };
  };
  export default nodemailer;
}
