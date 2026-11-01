// Email address checks, shared by the server's forms. Neither proves an address
// exists; they only catch typos. Length limits stay with each caller.

/** Something@something.something with no spaces. */
export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** Like isEmail, but also refuses < > and ", for an address that goes into a From header. */
export const isHeaderSafeEmail = (value: string) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value);
