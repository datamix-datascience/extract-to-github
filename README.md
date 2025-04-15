# extract-to-github
Extract Google Drive files and sync them to Github

## Quick  Test
```js
(async () => {
  const pdfFilePath = './test.pdf'; Replace with actual path
  const outputDir = './'; Replace with actual path
  const dpi = 300;

  const generatedFiles = await convert_pdf_to_pngs(pdfFilePath, outputDir, dpi);
  console.log('Generated files:', generatedFiles);
})();
```

## Release
```bash
# Make changes, commit, push...
chmod +x release.sh
./release.sh v1.0.0 # Use semantic versioning
```
