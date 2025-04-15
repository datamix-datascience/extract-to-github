import * as fs from 'fs';
import * as path from 'path';
import * as mupdfjs from 'mupdf/mupdfjs';
import { ColorSpace } from 'mupdf/mupdfjs';

export async function convert_pdf_to_pngs(pdf_file_path: string, output_image_dir: string, resolution_dpi: number) {
  const generated_files = [];
  let doc = null;

  try {
    const buffer = fs.readFileSync(pdf_file_path);
    doc = mupdfjs.PDFDocument.openDocument(buffer, "application/pdf");
    const page_count = doc.countPages();
    await fs.promises.mkdir(output_image_dir, { recursive: true });
    const scale = resolution_dpi / 72;
    const matrix = mupdfjs.Matrix.scale(scale, scale);

    for (let i = 0; i < page_count; i++) {
      const page = doc.loadPage(i);
      const pixmap = page.toPixmap(matrix, ColorSpace.DeviceRGB, false, true);
      const pngImage = pixmap.asPNG()
      const output_png_path = path.join(output_image_dir, `${String(i + 1).padStart(4, '0')}.png`);
      await fs.promises.writeFile(output_png_path, pngImage);
      generated_files.push(output_png_path);
      page.destroy();
      pixmap.destroy();
    }

    return generated_files;
  } catch (error) {
    console.error(`Error during PDF to PNG conversion for ${pdf_file_path}:`, error);
    return generated_files;
  } finally {
    if (doc) doc.destroy();
  }
}
