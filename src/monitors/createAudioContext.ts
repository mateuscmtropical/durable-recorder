interface AudioContextConstructors {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
}

// Older Safari only has webkitAudioContext.
function createAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const constructors: AudioContextConstructors = window;
    const constructAudioContext = constructors.AudioContext ?? constructors.webkitAudioContext;

    if (!constructAudioContext) {
        return null;
    }

    try {
        return new constructAudioContext();
    } catch {
        return null;
    }
}

export { createAudioContext };
