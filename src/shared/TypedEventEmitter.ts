type EventListener<Payload> = (payload: Payload) => void;

interface Registration<EventMap extends object> {
    listener: EventListener<EventMap[keyof EventMap]>;
    isOnce: boolean;
}

class TypedEventEmitter<EventMap extends object> {
    private readonly registrationsByEvent = new Map<keyof EventMap, Registration<EventMap>[]>();

    on<EventName extends keyof EventMap>(eventName: EventName, listener: EventListener<EventMap[EventName]>): () => void {
        this.addRegistration(eventName, listener, false);

        return () => {
            this.off(eventName, listener);
        };
    }

    once<EventName extends keyof EventMap>(eventName: EventName, listener: EventListener<EventMap[EventName]>): () => void {
        this.addRegistration(eventName, listener, true);

        return () => {
            this.off(eventName, listener);
        };
    }

    off<EventName extends keyof EventMap>(eventName: EventName, listener: EventListener<EventMap[EventName]>): void {
        const registrations = this.registrationsByEvent.get(eventName) ?? [];
        const remainingRegistrations = registrations.filter(registration => registration.listener !== listener);

        this.registrationsByEvent.set(eventName, remainingRegistrations);
    }

    emit<EventName extends keyof EventMap>(eventName: EventName, payload: EventMap[EventName]): void {
        const registrations = this.registrationsByEvent.get(eventName) ?? [];
        // Copy first so a listener that removes another one does not skip it.
        const registrationsCopy = [...registrations];

        registrationsCopy.forEach((registration) => {
            if (registration.isOnce) {
                this.off(eventName, registration.listener);
            }

            this.invokeListener(registration.listener, payload);
        });
    }

    removeAllListeners(): void {
        this.registrationsByEvent.clear();
    }

    listenerCount(eventName: keyof EventMap): number {
        const registrations = this.registrationsByEvent.get(eventName) ?? [];

        return registrations.length;
    }

    private addRegistration<EventName extends keyof EventMap>(
        eventName: EventName,
        listener: EventListener<EventMap[EventName]>,
        isOnce: boolean,
    ): void {
        const registrations = this.registrationsByEvent.get(eventName) ?? [];
        const isAlreadyRegistered = registrations.some(registration => registration.listener === listener);

        if (isAlreadyRegistered) {
            return;
        }

        const registration: Registration<EventMap> = {
            listener: listener as EventListener<EventMap[keyof EventMap]>,
            isOnce,
        };

        this.registrationsByEvent.set(eventName, [...registrations, registration]);
    }

    private invokeListener(listener: EventListener<EventMap[keyof EventMap]>, payload: EventMap[keyof EventMap]): void {
        try {
            listener(payload);
        } catch (error: unknown) {
            // Rethrow later so one failing listener does not stop the others
            // but still reaches the global error handler.
            queueMicrotask(() => {
                throw error;
            });
        }
    }
}

export { TypedEventEmitter };
export type { EventListener };
