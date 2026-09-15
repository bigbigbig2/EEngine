import {
  cookGeometryAssetPackage,
  type GeometryCookRecipe,
  type SourceGeometry
} from "../../../../OEngine/src/index.ts";

type CookRequest = Readonly<{
  id: number;
  source: SourceGeometry;
  recipe: GeometryCookRecipe;
}>;

type CookResponse =
  | Readonly<{ id: number; ok: true; bytes: ArrayBuffer }>
  | Readonly<{ id: number; ok: false; name: string; message: string; stack?: string }>;

self.addEventListener("message", (event: MessageEvent<CookRequest>) => {
  const request = event.data;
  void cookGeometryAssetPackage(request.source, request.recipe).then(
    (result) => {
      const response: CookResponse = { id: request.id, ok: true, bytes: result.bytes };
      self.postMessage(response, { transfer: [result.bytes] });
    },
    (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      const response: CookResponse = {
        id: request.id,
        ok: false,
        name: error.name,
        message: error.message,
        stack: error.stack
      };
      self.postMessage(response);
    }
  );
});
