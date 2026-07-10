import { readZipEntries } from './zip.js';

/** Extract plain text from a DOCX file (which is a ZIP holding word/document.xml). */
export function extractDocx(buffer) {
  const zip = readZipEntries(buffer);
  const doc = zip.read('word/document.xml');
  if (!doc) throw new Error('Not a DOCX file (word/document.xml missing)');
  const xml = doc.toString('utf8');

  const paragraphs = [];
  for (const para of xml.split('</w:p>')) {
    let text = '';
    // runs of literal text, tabs and line breaks in document order
    for (const match of para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      if (match[0].startsWith('<w:tab')) text += '\t';
      else if (match[0].startsWith('<w:br')) text += '\n';
      else text += decodeXml(match[1]);
    }
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs.join('\n\n');
}

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
