/** The part of the `qrcode` package this app uses (it ships no types of its own). */
declare module 'qrcode' {
  type Options = {
    type?: 'svg' | 'utf8' | 'terminal';
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
    color?: { dark?: string; light?: string };
  };
  const QRCode: { toString(text: string, options?: Options): Promise<string> };
  export default QRCode;
}
