/** The QR code an authenticator app scans, drawn on the server as SVG so the key never goes to a third party. */
import QRCode from 'qrcode';

export async function qrSvgDataUri(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#1a1a18', light: '#ffffff' } });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
