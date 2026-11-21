ALTER TABLE "mux_transcript_entry" ADD COLUMN "speakerId" UUID;
ALTER TABLE "rtmp_transcript_entry" ADD COLUMN "speakerId" UUID;
ALTER TABLE "shared_session_entry" ADD COLUMN "speakerId" UUID;
ALTER TABLE "transcript_session_entry" ADD COLUMN "speakerId" UUID;
