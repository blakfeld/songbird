export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Some browsers start the save asynchronously; revoking immediately can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
