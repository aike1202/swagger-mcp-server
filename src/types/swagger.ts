export interface SwaggerDoc {
  openapi: string;
  servers?: { url: string; description?: string }[];
  paths: Record<string, Record<string, any>>;
  components?: {
    schemas?: Record<string, any>;
  };
  info?: {
    title: string;
    version: string;
  };
}
