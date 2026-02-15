declare module "pdf-parse" {
  function pdfParse(data: Buffer | Uint8Array): Promise<{ text: string }>;
  export default pdfParse;
}
