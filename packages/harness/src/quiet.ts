// Imported first by the CLI: @livekit/rtc-node sets its logger to "debug" unless NODE_ENV is
// production, which buries the timeline under one line per data-stream chunk.
process.env.NODE_ENV ??= "production";
