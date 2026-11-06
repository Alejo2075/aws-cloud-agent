import { ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { GetResourcesCommand } from "@aws-sdk/client-resource-groups-tagging-api";
import { createClients } from "./clients.js";
import type { AwsClients } from "./clients.js";
import { DESCRIBERS, isAccessDenied } from "./describers.js";
import { AccessDeniedError } from "./port.js";
import type {
  AwsContext,
  AwsReadPort,
  DescribeTarget,
  ResourceDetail,
  StackResource,
  TaggedResource,
} from "./port.js";

/** AWS SDK v3 implementation of the read-only port. Uses only list, describe and get operations. */
export class SdkAwsReadPort implements AwsReadPort {
  constructor(
    readonly context: AwsContext,
    private readonly clients: AwsClients = createClients(context.region),
  ) {}

  async listStackResources(stack: string): Promise<StackResource[]> {
    const out: StackResource[] = [];
    let token: string | undefined;
    try {
      do {
        const r = await this.clients.cfn.send(
          new ListStackResourcesCommand({ StackName: stack, ...(token && { NextToken: token }) }),
        );
        for (const s of r.StackResourceSummaries ?? []) {
          if (s.LogicalResourceId && s.PhysicalResourceId && s.ResourceType) {
            out.push({
              stack,
              logicalId: s.LogicalResourceId,
              physicalId: s.PhysicalResourceId,
              type: s.ResourceType,
              status: s.ResourceStatus ?? "UNKNOWN",
            });
          }
        }
        token = r.NextToken;
      } while (token);
    } catch (e) {
      if (isAccessDenied(e)) throw new AccessDeniedError("cloudformation:ListStackResources", e);
      throw e;
    }
    return out;
  }

  async listResourcesByTag(key: string, value: string): Promise<TaggedResource[]> {
    const out: TaggedResource[] = [];
    let token: string | undefined;
    try {
      do {
        const r = await this.clients.tagging.send(
          new GetResourcesCommand({
            TagFilters: [{ Key: key, Values: [value] }],
            ...(token && { PaginationToken: token }),
          }),
        );
        for (const m of r.ResourceTagMappingList ?? []) {
          if (m.ResourceARN)
            out.push({
              arn: m.ResourceARN,
              tags: Object.fromEntries(
                (m.Tags ?? []).flatMap((t) => (t.Key ? [[t.Key, t.Value ?? ""]] : [])),
              ),
            });
        }
        token = r.PaginationToken || undefined;
      } while (token);
    } catch (e) {
      if (isAccessDenied(e)) throw new AccessDeniedError("tag:GetResources", e);
      throw e;
    }
    return out;
  }

  async describeResource(target: DescribeTarget): Promise<ResourceDetail> {
    const describer = DESCRIBERS[target.type];
    if (!describer) {
      return {
        summary: {},
        links: [],
        limitations: [`no describer for ${target.type}; listed without configuration or edges`],
      };
    }
    return describer(this.clients, target);
  }
}
