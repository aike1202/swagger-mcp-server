import { CallToolRequest, ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SwaggerLoader } from "../services/loader.js";
import { resolveSchema, jsonSchemaToTs } from "../utils/schema.js";
import axios, { AxiosError } from "axios";

export function registerTools(server: Server, loader: SwaggerLoader) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_services",
        description: "List all configured Swagger services.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "refresh_docs",
        description: "Force refresh the cached Swagger documentation from the source URL.",
        inputSchema: { 
          type: "object", 
          properties: {
              service_name: { type: "string", description: "Name of the service to refresh" }
          } 
        },
      },
      {
        name: "list_endpoints",
        description: "List all available API endpoints.",
        inputSchema: { 
          type: "object", 
          properties: {
              service_name: { type: "string", description: "Name of the service" }
          } 
        },
      },
      {
        name: "search_apis",
        description: "Search for APIs by keyword.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search keyword" },
            service_name: { type: "string", description: "Name of the service to search in" }
          },
          required: ["query"],
        },
      },
      {
        name: "get_endpoint_details",
        description: "Get full details of a specific API endpoint.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            method: { type: "string" },
            service_name: { type: "string" }
          },
          required: ["path", "method"],
        },
      },
      {
        name: "debug_endpoint",
        description: "Execute a real HTTP request to the API.",
        inputSchema: {
            type: "object",
            properties: {
                service_name: { type: "string" },
                path: { type: "string" },
                method: { type: "string" },
                path_params: { type: "object" },
                query_params: { type: "object" },
                headers: { type: "object" },
                body: { type: "object" }
            },
            required: ["path", "method"]
        }
      },
      {
        name: "generate_curl",
        description: "Generate a cURL command string.",
        inputSchema: {
            type: "object",
            properties: {
                service_name: { type: "string" },
                path: { type: "string" },
                method: { type: "string" },
                path_params: { type: "object" },
                query_params: { type: "object" },
                headers: { type: "object" },
                body: { type: "object" }
            },
            required: ["path", "method"]
        }
      }
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const args = request.params.arguments || {};
    const serviceNameArg = args.service_name as string | undefined;

    switch (request.params.name) {
      case "list_services": {
        const servicesList = Array.from(loader.getServices().entries()).map(([name, url]) => `${name}: ${url}`);
        return { content: [{ type: "text", text: servicesList.join("\n") }] };
      }

      case "refresh_docs": {
        const { doc, name } = await loader.getDoc(serviceNameArg, true);
        return {
          content: [{ type: "text", text: `Successfully refreshed documentation for '${name}'. Title: ${doc.info?.title || "Unknown"}` }],
        };
      }

      case "list_endpoints": {
        const { doc, name } = await loader.getDoc(serviceNameArg);
        const endpoints: string[] = [`Service: ${name}`];
        for (const [path, methods] of Object.entries(doc.paths)) {
          for (const [method, details] of Object.entries(methods)) {
            endpoints.push(`[${method.toUpperCase()}] ${path} - ${(details as any).summary || "No summary"}`);
          }
        }
        return { content: [{ type: "text", text: endpoints.join("\n") }] };
      }

      case "search_apis": {
        const query = String(args.query).toLowerCase().trim();
        const terms = query.split(/\s+/).filter(t => t.length > 0);
        const matches: { text: string; score: number }[] = [];
        const servicesToSearch = serviceNameArg ? [serviceNameArg] : Array.from(loader.getServices().keys());

        for (const sName of servicesToSearch) {
           try {
              const { doc } = await loader.getDoc(sName);
              for (const [path, methods] of Object.entries(doc.paths)) {
                  for (const [method, details] of Object.entries(methods) as [string, any][]) {
                      const summary = (details.summary || "").toLowerCase();
                      const description = (details.description || "").toLowerCase();
                      const pathLower = path.toLowerCase();
                      
                      let score = 0;
                      let matchedTermCount = 0;

                      for (const term of terms) {
                          let termScore = 0;
                          if (pathLower.includes(term)) termScore += 10; // Path match is most important
                          if (summary.includes(term)) termScore += 5;    // Summary match is important
                          if (description.includes(term)) termScore += 1; // Description match is bonus
                          
                          if (termScore > 0) {
                              score += termScore;
                              matchedTermCount++;
                          }
                      }

                      // Only include if at least one term matched
                      // Bonus points for matching multiple terms (AND logic preference)
                      if (score > 0) {
                          score += matchedTermCount * 20; 
                          matches.push({
                              text: `[${sName}] [${method.toUpperCase()}] ${path} - ${details.summary || "No summary"}`,
                              score
                          });
                      }
                  }
              }
           } catch (e) { console.error(`Skipping search for ${sName}`, e); }
        }

        // Sort by score descending
        matches.sort((a, b) => b.score - a.score);
        
        // Limit results to avoid context overflow
        const topMatches = matches.slice(0, 50).map(m => m.text);

        return { content: [{ type: "text", text: topMatches.length > 0 ? topMatches.join("\n") : "No matching APIs found." }] };
      }

      case "get_endpoint_details": {
        const path = String(args.path);
        const method = String(args.method).toLowerCase();
        const { doc, name } = await loader.getDoc(serviceNameArg);

        const pathObj = doc.paths[path];
        if (!pathObj) throw new McpError(ErrorCode.InvalidParams, `Path '${path}' not found in '${name}'.`);
        const methodObj = pathObj[method];
        if (!methodObj) throw new McpError(ErrorCode.InvalidParams, `Method '${method}' not found for '${path}' in '${name}'.`);

        const details = {
          service: name,
          summary: methodObj.summary,
          description: methodObj.description,
          parameters: methodObj.parameters?.map((p: any) => {
            const resolvedParam = resolveSchema(p, doc);
            return {
                name: resolvedParam.name,
                in: resolvedParam.in,
                required: resolvedParam.required,
                description: resolvedParam.description,
                schema: resolvedParam.schema
            };
          }),
          requestBody: methodObj.requestBody ? resolveSchema(methodObj.requestBody, doc) : undefined,
          responses: {},
        };

        if (methodObj.responses) {
          for (const [code, res] of Object.entries(methodObj.responses)) {
            (details.responses as any)[code] = resolveSchema(res, doc);
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
      }

      case "debug_endpoint": {
        const path = String(args.path);
        const method = String(args.method).toLowerCase();
        const pathParams = (args.path_params as Record<string, string>) || {};
        const queryParams = (args.query_params as Record<string, string>) || {};
        const headers = (args.headers as Record<string, string>) || {};
        let body = args.body as Record<string, any> | undefined;

        const { doc, baseUrl } = await loader.getDoc(serviceNameArg);
        
        // 1. Inject Auth Token if available
        const cachedToken = loader.getAuthToken();
        if (cachedToken && !headers["Authorization"]) {
            headers["Authorization"] = `Bearer ${cachedToken}`;
            // console.error(`[AutoAuth] Injected cached token.`);
        }

        // Auto-fill
        if (["post", "put", "patch"].includes(method)) {
            const pathObj = doc.paths[path];
            if (pathObj && pathObj[method] && pathObj[method].requestBody) {
                 const resolvedBody = resolveSchema(pathObj[method].requestBody, doc);
                 const schema = resolvedBody.content?.["application/json"]?.schema;
                 if (schema && schema.properties) {
                     body = body || {};
                     const required = schema.required || [];
                     for (const reqField of required) {
                         if (body[reqField] === undefined) {
                             const propSchema = schema.properties[reqField];
                             if (propSchema.type === "string") body[reqField] = "test_string";
                             else if (propSchema.type === "number" || propSchema.type === "integer") body[reqField] = 0;
                             else if (propSchema.type === "boolean") body[reqField] = false;
                             else if (propSchema.type === "array") body[reqField] = [];
                             else if (propSchema.type === "object") body[reqField] = {};
                         }
                     }
                 }
            }
        }
        
        let finalUrl = path;
        for (const [key, value] of Object.entries(pathParams)) {
            finalUrl = finalUrl.replace(`{${key}}`, value);
        }
        const url = `${baseUrl}${finalUrl}`;

            try {
                const response = await axios({
                    method,
                    url,
                    params: queryParams,
                    headers: { "Content-Type": "application/json", ...headers },
                    data: body
                });

                // 2. Capture Token from response (Heuristic)
                if (response.data && typeof response.data === "object") {
                    const tokenCandidate = response.data.token || response.data.accessToken || response.data.access_token || response.headers["authorization"];
                    if (tokenCandidate && typeof tokenCandidate === "string") {
                        const rawToken = tokenCandidate.replace(/^Bearer\s+/i, "");
                        if (rawToken.length > 20) {
                            loader.setAuthToken(rawToken);
                        }
                    }
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                            data: response.data
                        }, null, 2)
                    }]
                };
            } catch (error) {
                // Handle 401 Auto-Login Logic
                if (axios.isAxiosError(error) && error.response?.status === 401) {
                    const creds = loader.getCredentials();
                    if (creds) {
                        if (creds.loginPath) {
                             // Option B: Fully Automatic Login (if path is known)
                             try {
                                 console.error(`[AutoAuth] 401 detected. Attempting auto-login to ${creds.loginPath}...`);
                                 // Construct login URL (relative to base)
                                 const loginUrl = `${baseUrl}${creds.loginPath}`;
                                 // Guess payload format (standard or simple)
                                 const loginBody = { username: creds.user, password: creds.pass }; 
                                 
                                 const loginRes = await axios.post(loginUrl, loginBody);
                                 // Extract token
                                 const tokenCandidate = loginRes.data?.token || loginRes.data?.accessToken || loginRes.data?.access_token;
                                 if (tokenCandidate) {
                                     const newToken = tokenCandidate.replace(/^Bearer\s+/i, "");
                                     loader.setAuthToken(newToken);
                                     
                                     // Retry Original Request
                                     console.error(`[AutoAuth] Login success. Retrying original request...`);
                                     headers["Authorization"] = `Bearer ${newToken}`;
                                     const retryRes = await axios({
                                        method,
                                        url,
                                        params: queryParams,
                                        headers: { "Content-Type": "application/json", ...headers },
                                        data: body
                                     });
                                     
                                     return {
                                        content: [{
                                            type: "text",
                                            text: JSON.stringify({
                                                status: retryRes.status,
                                                data: retryRes.data
                                            }, null, 2)
                                        }]
                                    };
                                 }
                             } catch (loginErr) {
                                 console.error(`[AutoAuth] Auto-login failed: ${loginErr}`);
                             }
                        } else {
                            // Option A: Hint AI to login
                             return {
                                content: [{
                                    type: "text",
                                    text: `Request failed with 401 Unauthorized.\n\n💡 TIP: I have stored credentials (User: ${creds.user}). You can attempt to login by calling the appropriate login endpoint (e.g., POST /auth/login) with these credentials, and I will automatically cache the token for future requests.`
                                }],
                                isError: true
                            };
                        }
                    }
                }

                if (error instanceof AxiosError) {
                     return {
                        content: [{
                            type: "text",
                            text: `Request Failed:\nStatus: ${error.response?.status} ${error.response?.statusText}\nData: ${JSON.stringify(error.response?.data, null, 2)}\nMessage: ${error.message}`
                        }],
                        isError: true
                    };
                }
                throw error;
            }
      }

      case "generate_curl": {
        const path = String(args.path);
        const method = String(args.method).toUpperCase();
        const pathParams = (args.path_params as Record<string, string>) || {};
        const queryParams = (args.query_params as Record<string, string>) || {};
        const headers = (args.headers as Record<string, string>) || {};
        const body = args.body;

        const { baseUrl } = await loader.getDoc(serviceNameArg);
        
        let finalUrl = path;
        for (const [key, value] of Object.entries(pathParams)) {
            finalUrl = finalUrl.replace(`{${key}}`, value);
        }
        const urlObj = new URL(`${baseUrl}${finalUrl}`);
        for(const [k, v] of Object.entries(queryParams)) {
            urlObj.searchParams.append(k, v);
        }

        const parts = [`curl -X ${method} "${urlObj.toString()}"`];
        const allHeaders = { "Content-Type": "application/json", ...headers };
        for (const [k, v] of Object.entries(allHeaders)) {
            parts.push(`-H "${k}: ${v}"`);
        }

        if (body && ["POST", "PUT", "PATCH"].includes(method)) {
            parts.push(`-d '${JSON.stringify(body)}'`);
        }

        return { content: [{ type: "text", text: parts.join(" \\\n  ") }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, "Unknown tool");
    }
  });
}
