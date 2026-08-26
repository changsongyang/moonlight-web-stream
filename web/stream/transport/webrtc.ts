import { Api, fetchApi, WebRTCAnswer } from "../../api"
import { showNotification } from "../../component/notification"
import { ClientInputEvent, ControlHost, ControlPacket, ControlPacket_Tags, ControlPacketConfig, controlPacketDeserialize, controlPacketSerialize, InputBatcher, PacketDirection, VideoFormats, WebRtcSessionAnswer, webrtcSessionAnswerParse, WebRtcSessionOffer, webrtcSessionOfferApply } from "../../uniffi/moonlight_common_bindings"
import { globalObject, uniffiMillisUntil, uniffiNow, wait } from "../../util"
import { AudioPlayer, TrackAudioPlayer } from "../audio/index"
import { Logger } from "../log"
import { DataPipe } from "../pipeline/pipes"
import { StatValue } from "../stats"
import { TrackVideoRenderer, VideoRenderer } from "../video/index"
import { generateControlPacketConfig, IControlStream, Transport, TransportAudioType, TransportConnectData, TransportOptions, TransportShutdown, TransportVideoType } from "./index"

export class WebRTCTransport implements Transport {

    readonly implementationName: string = "webrtc"

    readonly controlStream
    onconnect: ((connectData: TransportConnectData) => void) | null = null
    onclose: ((shutdown: TransportShutdown) => void) | null = null

    private logger?: Logger

    private api: Api

    private peer: RTCPeerConnection
    private location: string | null = null

    constructor(api: Api, configuration: RTCConfiguration, logger?: Logger) {
        this.logger = logger

        this.api = api

        // Create peer
        this.peer = new RTCPeerConnection(configuration)
        this.controlStream = new WebRtcControlStream(this.peer)

        this.logger?.debug(`Using ice servers ${JSON.stringify(configuration.iceServers?.flatMap(server => server.urls))}`)

        // Set Event Listeners
        this.peer.addEventListener("connectionstatechange", this.onStateChange.bind(this))
        this.peer.addEventListener("datachannel", this.onDataChannel.bind(this))
        this.peer.addEventListener("track", this.onTrack.bind(this))

        // Ice Gathering
        this.peer.addEventListener("icecandidate", this.onIceCandidate.bind(this))

        // Add Media
        this.peer.addTransceiver("video", { direction: "recvonly" })
        this.peer.addTransceiver("audio", { direction: "recvonly" })

        // Dummy data channel required so that the answerer knows we accept data channels
        this.peer.createDataChannel("dummy")
    }

    private sdpOfferOptions: WebRtcSessionOffer | null = null
    private sdpAnswer: WebRtcSessionAnswer | null = null

    async createOffer(options: TransportOptions): Promise<string> {
        this.logger?.debug("Creating webrtc offer")

        let offer = await this.peer.createOffer()
        if (offer.type != "offer") {
            throw `WHEP offer is of type ${offer.type}`
        }

        this.logger?.debug("Setting webrtc local description")
        await this.peer.setLocalDescription(offer)

        // Insert custom options
        this.sdpOfferOptions = {
            controlEnet: false,
            ...options
        }
        const sdp = webrtcSessionOfferApply(offer.sdp ?? "", this.sdpOfferOptions)

        this.logger?.debug(`successfully generated webrtc sdp with options ${JSON.stringify(this.sdpOfferOptions)}`)
        console.debug("Client Sdp", sdp)

        this.logger?.debug(`starting ice candidate sender`)
        this.sendIceCandidates()

        return sdp
    }
    async setAnswer(response: WebRTCAnswer): Promise<void> {
        console.debug("server sdp", JSON.stringify(response))

        this.logger?.debug(`received whep response with location "${response.location}"`)
        // Print ice candidates
        for (const line of response.answerSdp.split("\r\n")) {
            if (line.startsWith("a=candidate")) {
                this.logger?.debug(`received remote ice candidate ${line.substring(2)}`)
            }
        }

        this.location = response.location

        this.sdpAnswer = webrtcSessionAnswerParse(response.answerSdp)
        this.logger?.debug(`Server responded with extensions ${JSON.stringify(this.sdpAnswer)}`)

        await this.peer.setRemoteDescription({
            type: "answer",
            sdp: response.answerSdp,
        })
    }

    private connectData: TransportConnectData | null = null
    private async generateConnectData(): Promise<TransportConnectData> {
        if (this.connectData) {
            return this.connectData
        }

        if (!this.videoStream || !this.audioStream) {
            throw `WebRTC WHEP response didn't contain a video and audio stream! Video: ${this.videoStream != null}, Audio: ${this.audioStream != null}`
        }
        const codec = await this.findOutCodec()

        const audioSettings = this.audioStream.getSettings()

        this.connectData = {
            capabilities: {
                touch: false
            },
            videoType: "videotrack",
            videoSetup: {
                // Assume the requested parameters are correct
                width: this.sdpOfferOptions?.width ?? -1,
                height: this.sdpOfferOptions?.height ?? -1,
                fps: this.sdpOfferOptions?.fps ?? -1,
                codec,
            },
            audioType: "audiotrack",
            audioSetup: {
                channels: audioSettings.channelCount ?? 2,
                sampleRate: audioSettings.sampleRate ?? 48000,
                // TODO
                streams: 0,
                coupledStreams: 0,
                samplesPerFrame: 0,
                mapping: []
            },
            appName: this.sdpAnswer?.appName ?? "Unknown"
        }
        return this.connectData
    }

    private wasConnected = false
    private onStateChange() {
        if (this.peer.connectionState == "connected") {
            this.wasConnected = true

            this.generateConnectData().then(connectData => {
                if (this.onconnect) {
                    this.onconnect(connectData)
                }
            })
        } else if (this.peer.connectionState == "failed" || this.peer.connectionState == "closed") {
            const shutdown = this.wasConnected ? "failed" : "failednoconnect"

            if (this.onclose) {
                this.onclose(shutdown)
            }
        }
    }

    // -- Trickle Ice
    private iceCandidateSendTimer: number | null = null
    private pendingIceCandidates: Array<string> = []
    private onIceCandidate(event: RTCPeerConnectionIceEvent) {
        if (!event.candidate) {
            // Ice Gathering finished
            this.logger?.debug("ice gathering finished")
            return
        }

        const candidate = event.candidate.toJSON().candidate
        if (candidate) {
            this.pendingIceCandidates.push(candidate)
        }
    }

    private boundSendIceCandidates = this.sendIceCandidates.bind(this)
    private async sendIceCandidates() {
        this.iceCandidateSendTimer = null
        if (this.iceCandidateSendTimer != null) {
            globalObject().clearTimeout(this.iceCandidateSendTimer)
        }

        for (const candidate of this.pendingIceCandidates) {
            this.logger?.debug(`sending ice candidate: ${candidate}`)
        }

        if (this.location && this.pendingIceCandidates.length > 0) {
            const trickleIceSdpFrag = this.pendingIceCandidates.map(x => `a=${x}`).join("\r\n")

            await fetchApi(this.api, this.location, "PATCH", {
                noUrlModify: true,
                trickleIceSdpFrag,
                response: "ignore",
            })

            this.pendingIceCandidates = []
        }

        if (this.peer.iceGatheringState != "complete") {
            this.iceCandidateSendTimer = globalObject().setTimeout(this.boundSendIceCandidates, 2000)
        }
    }

    // -- Control Stream / Media
    private onDataChannel(event: RTCDataChannelEvent) {
        const channel = event.channel

        this.logger?.debug(`received data channel with label: ${channel.label}`)

        if (channel.label == "moonlight.control") {
            const config = generateControlPacketConfig()

            this.controlStream.setChannel(channel, config)
        }
    }

    private onTrack(event: RTCTrackEvent) {
        event.receiver.jitterBufferTarget = 0
        if ("playoutDelayHint" in event.receiver) {
            event.receiver.playoutDelayHint = 0
        }
        const track = event.track

        this.logger?.debug(`received track with label: ${track.label}, kind: ${track.kind}`)

        if (track.kind == "video") {
            track.contentHint = "motion"

            this.videoStream = track
        } else if (track.kind == "audio") {
            this.audioStream = track
        }
    }

    // Video
    private videoStream: MediaStreamTrack | null = null

    setVideoPipeline(type: "videotrack", pipeline: (TrackVideoRenderer & VideoRenderer)): Promise<void>;
    setVideoPipeline(type: "data", pipeline: (DataPipe & VideoRenderer)): Promise<void>;
    async setVideoPipeline(type: TransportVideoType, pipeline: unknown): Promise<void> {
        if (!this.videoStream || !this.connectData) {
            throw "the stream must be connected!"
        }

        if (type == "videotrack") {
            const trackPipeline = pipeline as (TrackVideoRenderer & VideoRenderer)

            trackPipeline.setTrack(this.videoStream)
        } else if (type == "data") {
            throw "unimplemented"
        }
    }

    // Audio
    private audioStream: MediaStreamTrack | null = null

    setAudioPipeline(type: "audiotrack", pipeline: (TrackAudioPlayer & AudioPlayer)): Promise<void>
    setAudioPipeline(type: "data", pipeline: (DataPipe & AudioPlayer)): Promise<void>
    async setAudioPipeline(type: TransportAudioType, pipeline: AudioPlayer): Promise<void> {
        if (!this.audioStream || !this.connectData) {
            throw "the stream must be connected!"
        }

        if (type == "audiotrack") {
            const trackPipeline = pipeline as (TrackAudioPlayer & AudioPlayer)

            trackPipeline.setTrack(this.audioStream)
        } else if (type == "data") {
            throw "unimplemented"
        }
    }

    async close(): Promise<void> {
        // Close the peer
        this.peer.close()

        // Delete the ice candidate send loop
        globalObject().clearTimeout(this.iceCandidateSendTimer)
        this.iceCandidateSendTimer = null

        // Delete our current session on the server
        if (this.location) {
            try {
                await fetchApi(this.api, this.location, "DELETE", {
                    keepalive: true,
                    noUrlModify: true,
                    response: "ignore",
                })
            } catch (e) {
                console.debug("failed to DELETE webrtc session", e)
            }
        }
    }

    private async findOutCodec(): Promise<keyof VideoFormats> {
        let tries = 0

        while (true) {
            const stats = await this.peer.getStats()
            for (const [_key, value] of stats) {
                // Video Stream
                if ("type" in value && "kind" in value
                    && value.type == "inbound-rtp" && value.kind == "video"
                ) {

                }
            }
            tries += 1
            if (tries > 10) {
                this.logger?.debug(`failed to determine codec using stats after ${tries} tries, assuming h264`)
                return "h264"
            }

            await wait(100)
        }
    }

    private lastTotalDecodeTime = 0
    private lastFramesDecoded = 0
    async getStats(): Promise<Record<string, StatValue>> {
        const out: Record<string, StatValue> = {}

        // Control Stream
        // TODO

        const stats = await this.peer.getStats()

        for (const [_key, value] of stats) {
            console.debug(value)

            // Video Stream
            if ("type" in value && "kind" in value
                && value.type == "inbound-rtp" && value.kind == "video"
            ) {
                out.resolution = `Width: ${value?.frameWidth}, Height: ${value?.frameHeight}`

                out.framesDecoded = value?.framesDecoded
                out.framesDropped = value?.framesDropped
                out.keyFramesDecoded = value?.keyFramesDecoded

                out.packetsLost = value?.packetsLost
                out.packetsReceived = value?.packetsReceived

                out.nackCount = value?.nackCount
                out.pliCount = value?.pliCount
                out.firCount = value?.firCount

                if ("totalDecodeTime" in value && "framesDecoded" in value) {
                    out.decodeTimePerFrameMs = (value.totalDecodeTime - this.lastTotalDecodeTime) / (value.framesDecoded - this.lastFramesDecoded) * 1000.0

                    this.lastFramesDecoded = value.framesDecoded
                    this.lastTotalDecodeTime = value.totalDecodeTime
                }

                out.currentFps = value?.framesPerSecond
            }
            if ("type" in value && "mimeType" in value && typeof value.mimeType == "string"
                && value.type == "codec" && value.mimeType.startsWith("video/")
            ) {
                out.codec = value.mimeType.substring(6)
                out.codecSdpFmtpLine = value?.sdpFmtpLine
            }

            // Audio Stream
        }

        return out
    }
}

class WebRtcControlStream implements IControlStream {

    private logger?: Logger

    private config: ControlPacketConfig | null = null

    private channel: RTCDataChannel | null = null

    private keyLike: RTCDataChannel

    private mouse: RTCDataChannel

    private controller: RTCDataChannel

    private batcher: InputBatcher = new InputBatcher()

    private packetBuffer: Array<ControlPacket> = []

    constructor(peer: RTCPeerConnection, logger?: Logger) {
        this.logger = logger

        this.keyLike = peer.createDataChannel("moonlight.control.key_like", {
            ordered: false,
            maxPacketLifeTime: 150,
        })
        this.mouse = peer.createDataChannel("moonlight.control.mouse", {
            ordered: false,
            maxRetransmits: 0,
        })
        this.controller = peer.createDataChannel("moonlight.control.controller", {
            ordered: false,
            maxRetransmits: 0,
        })

        for (const channel of [this.keyLike, this.mouse, this.controller]) {
            channel.onbufferedamountlow = this.boundTrySendBufferedPackets
        }
    }

    setChannel(channel: RTCDataChannel | null, config?: ControlPacketConfig): void {
        if (channel && config) {
            this.channel = channel

            this.config = config

            this.channel.binaryType = "arraybuffer"

            this.channel.addEventListener("open", this.boundTrySendBufferedPackets)
            this.channel.addEventListener("bufferedamountlow", this.boundTrySendBufferedPackets)
            this.channel.addEventListener("message", this.boundMessage)

            this.trySendBufferedPackets()
        } else {
            this.channel?.removeEventListener("open", this.boundTrySendBufferedPackets)
            this.channel?.removeEventListener("bufferedamountlow", this.boundTrySendBufferedPackets)
            this.channel?.removeEventListener("message", this.boundMessage)

            this.channel = null
        }
    }

    onreceive: ((packet: ControlPacket) => void) | null = null

    private boundMessage = this.onMessage.bind(this)
    private onMessage(event: MessageEvent) {
        if (!this.config) {
            throw "packet config not configured, but a packet was received"
        }

        const packet = controlPacketDeserialize(this.config, PacketDirection.ClientBound, event.data)

        if (packet && this.onreceive) {
            this.onreceive(packet)
        }
    }

    send(input: ClientInputEvent): void {
        for (const packet of this.batcher.batchInput(input)) {
            this.sendRaw(packet)
        }

        this.sendBatchedInputs()
    }

    sendRaw(packet: ControlPacket): void {
        this.trySendBufferedPackets()

        if (!this.trySendRaw(packet)) {
            this.packetBuffer.push(packet)
        }
    }
    private trySendRaw(packet: ControlPacket): boolean {
        if (!this.channel || !this.config) {
            return false
        }

        let channel = this.channel
        let maxBufferedAmount = 16 * 1024
        let canDrop = false
        switch (packet.tag) {
            case ControlPacket_Tags.MouseMoveRelative:
            case ControlPacket_Tags.MouseMoveAbsolute:
                channel = this.mouse
                maxBufferedAmount = 1024
                canDrop = true
                break
            case ControlPacket_Tags.MouseButton:
            case ControlPacket_Tags.Keyboard:
                channel = this.keyLike
                maxBufferedAmount = 1024
                canDrop = true
                break
            case ControlPacket_Tags.ControllerState:
                channel = this.controller
                maxBufferedAmount = 4096
                canDrop = true
                break
        }

        if (
            channel.readyState != "open" ||
            channel.bufferedAmount > maxBufferedAmount
        ) {
            if (canDrop) {
                console.info(packet, "dropping packet because of exceeded buffered amount")
                return true
            }
            return false
        }

        console.debug(packet, `sending packet over ${channel.label}`)
        const data = controlPacketSerialize(this.config, packet)
        if (data) {
            channel.send(data)
        }

        return true
    }

    private boundTrySendBufferedPackets = this.trySendBufferedPackets.bind(this)
    private trySendBufferedPackets() {
        // Try to send packets
        for (const packet of this.packetBuffer.splice(0)) {
            if (!this.trySendRaw(packet)) {
                this.packetBuffer.push(packet)
            }
        }
    }

    private sendBatchedInputs() {
        for (const packet of this.batcher.removeBatchedInputs()) {
            this.sendRaw(packet)
        }
    }
}
