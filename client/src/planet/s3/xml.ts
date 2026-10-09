/**
 * Minimal XML reader for S3 responses. Service Workers have no DOMParser, and S3 responses only use
 * elements, text, the predefined entities and numeric character references. DTDs are rejected.
 */

export interface XmlElement {
    /** Local name, without any namespace prefix. */
    name: string;
    children: XmlElement[];
    /** Concatenated character data of the element's direct text and CDATA nodes. */
    text: string;
}

export class XmlParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "XmlParseError";
    }
}

const MAX_DEPTH = 32;
const NAME_PATTERN = /^[A-Za-z_][\w.:-]*$/;
const PREDEFINED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function localName(qualified: string): string {
    const colon = qualified.indexOf(":");
    return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function decodeEntities(raw: string): string {
    if (!raw.includes("&")) {
        return raw;
    }
    return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);|&/g, (match, entity: string | undefined) => {
        if (entity === undefined) {
            throw new XmlParseError("Unescaped '&' in character data");
        }
        if (entity.startsWith("#")) {
            const codePoint = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            if (!Number.isFinite(codePoint) || codePoint < 1 || codePoint > 0x10ffff) {
                throw new XmlParseError(`Invalid character reference '${match}'`);
            }
            return String.fromCodePoint(codePoint);
        }
        const value = PREDEFINED_ENTITIES[entity];
        if (value === undefined) {
            throw new XmlParseError(`Unknown entity '${match}'`);
        }
        return value;
    });
}

/** Finds the end of a start or end tag, skipping '>' inside quoted attribute values. */
function findTagEnd(source: string, from: number): number {
    let quote: string | null = null;
    for (let i = from; i < source.length; i++) {
        const c = source[i];
        if (quote !== null) {
            if (c === quote) {
                quote = null;
            }
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === ">") {
            return i;
        }
    }
    throw new XmlParseError("Unterminated tag");
}

export function parseXml(source: string): XmlElement {
    const stack: XmlElement[] = [];
    let root: XmlElement | null = null;
    let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;

    const current = (): XmlElement | undefined => stack[stack.length - 1];

    while (pos < source.length) {
        const lt = source.indexOf("<", pos);
        const textEnd = lt === -1 ? source.length : lt;
        if (textEnd > pos) {
            const text = source.slice(pos, textEnd);
            const parent = current();
            if (parent) {
                parent.text += decodeEntities(text);
            } else if (text.trim() !== "") {
                throw new XmlParseError("Character data outside the root element");
            }
        }
        if (lt === -1) {
            break;
        }
        if (source.startsWith("<?", lt)) {
            const end = source.indexOf("?>", lt + 2);
            if (end === -1) {
                throw new XmlParseError("Unterminated processing instruction");
            }
            pos = end + 2;
        } else if (source.startsWith("<!--", lt)) {
            const end = source.indexOf("-->", lt + 4);
            if (end === -1) {
                throw new XmlParseError("Unterminated comment");
            }
            pos = end + 3;
        } else if (source.startsWith("<![CDATA[", lt)) {
            const end = source.indexOf("]]>", lt + 9);
            const parent = current();
            if (end === -1 || !parent) {
                throw new XmlParseError("Misplaced or unterminated CDATA section");
            }
            parent.text += source.slice(lt + 9, end);
            pos = end + 3;
        } else if (source.startsWith("<!", lt)) {
            throw new XmlParseError("Document type declarations are not supported");
        } else if (source.startsWith("</", lt)) {
            const end = findTagEnd(source, lt + 2);
            const name = localName(source.slice(lt + 2, end).trim());
            const open = stack.pop();
            if (!open || open.name !== name) {
                throw new XmlParseError(`Unexpected closing tag '${name}'`);
            }
            pos = end + 1;
        } else {
            const end = findTagEnd(source, lt + 1);
            const selfClosing = source[end - 1] === "/";
            const body = source.slice(lt + 1, selfClosing ? end - 1 : end);
            const qualified = body.split(/\s/, 1)[0] ?? "";
            if (!NAME_PATTERN.test(qualified)) {
                throw new XmlParseError(`Invalid element name '${qualified}'`);
            }
            const element: XmlElement = { name: localName(qualified), children: [], text: "" };
            const parent = current();
            if (parent) {
                parent.children.push(element);
            } else if (root) {
                throw new XmlParseError("Multiple root elements");
            } else {
                root = element;
            }
            if (!selfClosing) {
                if (stack.length >= MAX_DEPTH) {
                    throw new XmlParseError("Document nesting is too deep");
                }
                stack.push(element);
            }
            pos = end + 1;
        }
    }
    if (stack.length > 0) {
        throw new XmlParseError(`Unclosed element '${stack[stack.length - 1]?.name}'`);
    }
    if (!root) {
        throw new XmlParseError("Empty document");
    }
    return root;
}

export function xmlChild(element: XmlElement, name: string): XmlElement | undefined {
    return element.children.find((child) => child.name === name);
}

export function xmlChildren(element: XmlElement, name: string): XmlElement[] {
    return element.children.filter((child) => child.name === name);
}

export function xmlChildText(element: XmlElement, name: string): string | undefined {
    return xmlChild(element, name)?.text;
}

export function escapeXmlText(value: string): string {
    return value.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
