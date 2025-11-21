import axios from "axios";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { SwaggerDoc } from "../types/swagger.js";

export class SwaggerLoader {
  private services: Map<string, string> = new Map();
  private cache: Map<string, SwaggerDoc> = new Map();
  private authToken: string | null = null;
  private credentials: { user: string; pass: string; loginPath?: string } | null = null;

  constructor() {
    this.parseArgs();
  }

  public setAuthToken(token: string) {
    this.authToken = token;
    console.error(`[Auth] Token cached successfully.`);
  }

  public getAuthToken(): string | null {
    return this.authToken;
  }

  public getCredentials() {
      return this.credentials;
  }

  private parseArgs() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      this.services.set("default", "http://localhost:8090/v3/api-docs");
      console.error("No arguments provided. Using default: http://localhost:8090/v3/api-docs");
      return;
    }

    for (const arg of args) {
      if (arg.startsWith("auth=")) {
          // Format: auth=user:pass OR auth=/login/path:user:pass
          const val = arg.substring(5);
          const parts = val.split(":");
          if (parts.length === 2) {
              this.credentials = { user: parts[0], pass: parts[1] };
              console.error(`[Auth] Credentials loaded for user: ${parts[0]}`);
          } else if (parts.length === 3) {
              this.credentials = { loginPath: parts[0], user: parts[1], pass: parts[2] };
              console.error(`[Auth] Auto-login configured. Path: ${parts[0]}, User: ${parts[1]}`);
          }
      } else if (arg.includes("=")) {
        const [name, url] = arg.split("=", 2);
        this.services.set(name, url);
        console.error(`Registered service '${name}': ${url}`);
      } else {
        if (arg.startsWith("http")) {
          this.services.set("default", arg);
          console.error(`Registered default service: ${arg}`);
        } else {
          console.error(`Ignoring invalid argument: ${arg}. Expected format: name=url or http://...`);
        }
      }
    }
  }

  public getServices(): Map<string, string> {
      return this.services;
  }

  public async getDoc(serviceName?: string, forceRefresh = false): Promise<{ doc: SwaggerDoc; name: string; baseUrl: string }> {
    let name = serviceName;
    if (!name) {
      if (this.services.size === 1) {
        name = this.services.keys().next().value;
      } else {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Multiple services configured. Please specify 'service_name'. Available: ${Array.from(this.services.keys()).join(", ")}`
        );
      }
    }

    if (!name || !this.services.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Service '${name}' not found. Available: ${Array.from(this.services.keys()).join(", ")}`);
    }

    const docUrl = this.services.get(name)!;
    let doc: SwaggerDoc;

    if (this.cache.has(name) && !forceRefresh) {
      doc = this.cache.get(name)!;
    } else {
      try {
        console.error(`Fetching Swagger docs for '${name}' from ${docUrl}...`);
        const response = await axios.get(docUrl);
        doc = response.data;
        this.cache.set(name, doc);
      } catch (error) {
        // Retry with 127.0.0.1 if localhost failed (Node 17+ IPv6 issue)
        if (docUrl.includes("localhost") && (error as any).code === "EACCES" || (error as any).code === "ECONNREFUSED") {
            try {
                const ipv4Url = docUrl.replace("localhost", "127.0.0.1");
                console.error(`Retrying with 127.0.0.1: ${ipv4Url}...`);
                const response = await axios.get(ipv4Url);
                doc = response.data;
                this.cache.set(name, doc);
                // Update service url to avoid future errors
                this.services.set(name, ipv4Url);
            } catch (retryError) {
                 const msg = error instanceof Error ? error.message : String(error);
                 throw new McpError(
                  ErrorCode.InternalError,
                  `Failed to fetch Swagger docs for '${name}': ${msg}. Please ensure the service at ${docUrl} is running.`
                );
            }
        } else {
            const msg = error instanceof Error ? error.message : String(error);
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch Swagger docs for '${name}': ${msg}. Please ensure the service at ${docUrl} is running.`
            );
        }
      }
    }

    let baseUrl = "";
    if (doc.servers && doc.servers.length > 0) {
      baseUrl = doc.servers[0].url;
      if (!baseUrl.startsWith("http")) {
        const docUrlObj = new URL(docUrl);
        baseUrl = new URL(baseUrl, docUrlObj.origin).toString();
      }
    } else {
      const docUrlObj = new URL(docUrl);
      baseUrl = docUrlObj.origin;
    }
    if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);

    return { doc, name, baseUrl };
  }
}
