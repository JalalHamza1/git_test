# Task Manager (home): PocketBase plus the app files, for Synology Container Manager.
# The build downloads the official PocketBase release that matches the NAS's processor.
FROM alpine:3.20

ARG PB_VERSION=0.40.4

RUN apk add --no-cache ca-certificates tzdata wget unzip \
 && case "$(uname -m)" in \
      x86_64) ARCH=amd64 ;; \
      aarch64) ARCH=arm64 ;; \
      armv7l) ARCH=armv7 ;; \
      *) echo "Unsupported processor: $(uname -m)" && exit 1 ;; \
    esac \
 && wget -q -O /tmp/pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${ARCH}.zip" \
 && mkdir -p /pb \
 && unzip -q /tmp/pb.zip pocketbase -d /pb \
 && rm /tmp/pb.zip \
 && chmod +x /pb/pocketbase

COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks
COPY pb_public /pb/pb_public

EXPOSE 8090
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8090", "--dir=/pb/pb_data"]
