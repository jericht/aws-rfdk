#!/bin/bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Mounts a file-systen for use with an NFS server.
#
# Script Arguments:
#  $1 -- NFS server endpoint (IP address or hostname)
#  $2 -- NFS server directory; this must be exported by the NFS server to this client
#  $3 -- Mount path; directory to mount the NFS share
#  $4 -- (Optional) NFS mount options; see https://linux.die.net/man/5/nfs

if [ $# -lt 3 ]; then
  echo "Usage: $0 <nfs-server-endpoint> <nfs-server-directory> <mount-path> [<mount-options>]"
  exit 1
fi

NFS_SERVER_ENDPOINT=$1
NFS_SERVER_DIRECTORY=$2
MOUNT_PATH=$3
MOUNT_OPTIONS="${4:-}"

if which yum; then
  sudo yum install -y nfs-utils
else
  sudo apt-get install -y nfs-common
fi

sudo mkdir -p "$MOUNT_PATH"

# fstab may be missing a newline at end of file.
if test $(tail -c 1 /etc/fstab | wc -l) -eq 0
then
  # Newline was missing, so add one.
  echo "" | sudo tee -a /etc/fstab
fi

echo "$NFS_SERVER_ENDPOINT:$NFS_SERVER_DIRECTORY $MOUNT_PATH nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,_netdev,$MOUNT_OPTIONS 0 0" | sudo tee -a /etc/fstab

# We can sometimes fail to mount the NFS share with a "Connection reset by host" error, or similar. 
# To counteract this, as best we can, we try to mount the NFS share a handful of times and fail-out
# only if unable to mount it after that.
TRIES=0
MAX_TRIES=20
while test ${TRIES} -lt ${MAX_TRIES} && ! sudo mount -a -t nfs4
do
  let TRIES=TRIES+1
  sleep 2
done

# Check whether the drive as been mounted. Fail if not.
cat /proc/mounts | grep "${MOUNT_PATH}"
exit $?
