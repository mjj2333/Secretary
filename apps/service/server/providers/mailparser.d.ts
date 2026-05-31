/**
 * Minimal hand-written ambient type declaration for mailparser@3.x.
 * The package ships no TypeScript types; these cover exactly what ImapProvider.ts needs.
 */
declare module 'mailparser' {
  import type { Readable } from 'stream';

  /** One entry inside an AddressObject.value array */
  export interface AddressEntry {
    name: string;
    address?: string;
    group?: AddressEntry[];
  }

  /** Structured address field (from, to, cc, bcc, replyTo) */
  export interface AddressObject {
    value: AddressEntry[];
    html: string;
    text: string;
  }

  export interface AttachmentCommon {
    type: 'attachment';
    content: Buffer;
    contentType: string;
    partId?: string;
    release?: () => void;
    contentDisposition?: string;
    filename?: string;
    headers?: Map<string, unknown>;
    checksum?: string;
    size: number;
    contentId?: string;
    cid?: string;
    related?: boolean;
  }

  export interface ParsedMail {
    headers: Map<string, unknown>;
    headerLines?: Array<{ key: string; line: string }>;
    html?: string | false;
    text?: string;
    textAsHtml?: string;
    subject?: string;
    references?: string | string[];
    date?: Date;
    to?: AddressObject | AddressObject[];
    from?: AddressObject;
    cc?: AddressObject | AddressObject[];
    bcc?: AddressObject | AddressObject[];
    replyTo?: AddressObject;
    messageId?: string;
    inReplyTo?: string;
    attachments: AttachmentCommon[];
  }

  export interface Options {
    skipHtmlToText?: boolean;
    maxHtmlLengthToParse?: number;
    keepCidLinks?: boolean;
    skipImageLinks?: boolean;
    skipTextToHtml?: boolean;
    skipTextLinks?: boolean;
    Iconv?: unknown;
  }

  export function simpleParser(
    input: string | Buffer | Readable,
    options?: Options,
  ): Promise<ParsedMail>;
}
