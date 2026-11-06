import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { EventPublisher, LifecycleEvent } from "@cloud-agent/changes";

/** Publishes lifecycle events to an event bus you own. Detail contains identifiers and states only. */
export class EventBridgePublisher implements EventPublisher {
  constructor(
    private readonly o: { client: EventBridgeClient; eventBusName: string; source?: string },
  ) {}

  async publish(event: LifecycleEvent): Promise<void> {
    const r = await this.o.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.o.eventBusName,
            Source: this.o.source ?? "cloud-agent",
            DetailType: event.type,
            Detail: JSON.stringify(event),
          },
        ],
      }),
    );
    if (r.FailedEntryCount)
      throw new Error(r.Entries?.[0]?.ErrorMessage ?? "EventBridge rejected the event");
  }
}
